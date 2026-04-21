// agent.js
import axios from 'axios';
import https from 'node:https';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

// Throttle: garantiza minimo 6 segundos entre llamadas a Claude
// Con Tier 1 (10k output tokens/min) y ~200 tokens/llamada = max 50 calls/min
// 6s entre llamadas = max 10 calls/min con concurrencia 3 = sin rate limit
let _lastCallTime = 0;
const MIN_CALL_INTERVAL_MS = 6000;
async function throttledClaude() {
  const now = Date.now();
  const wait = MIN_CALL_INTERVAL_MS - (now - _lastCallTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallTime = Date.now();
}

// Prompt comprimido — mismo contenido, menos tokens
const SYSTEM_PROMPT = `Inspector de Oficina Tecnica de Famiq. Auditas fichas de producto web.

Inputs:
- texto_comercial: nombre oficial interno (FUENTE DE VERDAD)
- titulo_web: titulo publicado en famiq.com.ar
- descripcion_web: texto descriptivo de la pagina
- specs: tabla de especificaciones tecnicas
- imagen adjunta (si disponible): primera foto del carrusel

Validar:
A) VISUAL (solo si hay imagen): la imagen corresponde al texto_comercial?
B) TECNICO texto_comercial vs specs: material (304/304L/316/316L), diametro (mm/DN/pulg), norma (DAN/DIN/SMS/SCH), conexion. Campo por campo.
C) TEXTO WEB vs specs: titulo_web y descripcion_web coinciden con specs?

Errores criticos: material wrong, diametro wrong, norma wrong, imagen de otro producto, specs de otro SKU.
Recomendaciones: titulo mal redactado, specs incompletas, descripcion generica.

Responde SOLO JSON valido:
{"estado_visual":"COHERENTE"|"ERROR"|"SIN_IMAGEN","analisis_visual":"texto","estado_tecnico":"OK"|"ERROR","validaciones":"campo:maestro=X tabla=Y OK/ERR | ...","discrepancias":"lista o Sin discrepancias","recomendaciones":"lista o Sin recomendaciones","propuesta_correccion":"texto o No requiere correccion"}`;

// Resultado posible: { data, mime } | null (sin URL) | { downloadError: true, status, message }
async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) return null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 40000,
        maxContentLength: 3 * 1024 * 1024,
        validateStatus: (s) => s >= 200 && s < 400,
        httpsAgent: insecureAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.famiq.com.ar/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });
      const buf = Buffer.from(res.data);
      if (buf.length > 2.5 * 1024 * 1024) { console.warn(`[agent] imagen muy grande: ${buf.length}`); return null; }
      let mime = (res.headers['content-type'] || '').split(';')[0].trim();
      if (!mime.startsWith('image/')) mime = 'image/jpeg';
      console.log(`[agent] imagen ok (${buf.length} bytes)`);
      return { data: buf.toString('base64'), mime };
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      console.warn(`[agent] imagen intento ${attempt}/3 error HTTP ${status || 'red'}: ${err?.message?.slice(0,100)}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
  // Falló por error de red/servidor — NO es que no exista imagen
  const status = lastErr?.response?.status;
  console.warn(`[agent] imagen FALLO DEFINITIVO (${status || 'sin respuesta'}) para: ${imageUrl}`);
  return { downloadError: true, status: status || 0, message: lastErr?.message || 'Sin respuesta' };
}

function safeParseJson(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'').trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) try { return JSON.parse(s.slice(a, b+1)); } catch {}
  return null;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return {
    estado_visual:'SIN_IMAGEN', analisis_visual:'Sin imagen.', estado_tecnico:'ERROR',
    validaciones:'', discrepancias:'', recomendaciones:'', propuesta_correccion:''
  };
  const v = String(raw.estado_visual||'').toUpperCase();
  return {
    estado_visual: v==='COHERENTE'?'COHERENTE': v==='ERROR'?'ERROR': v==='ERROR_DESCARGA'?'ERROR_DESCARGA':'SIN_IMAGEN',
    analisis_visual:      String(raw.analisis_visual      ||'').trim(),
    estado_tecnico:       String(raw.estado_tecnico       ||'').toUpperCase()==='OK'?'OK':'ERROR',
    validaciones:         String(raw.validaciones         ||'').trim(),
    discrepancias:        String(raw.discrepancias        ||'').trim(),
    recomendaciones:      String(raw.recomendaciones      ||'').trim(),
    propuesta_correccion: String(raw.propuesta_correccion ||'').trim()
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function auditScrape(scrape, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  const errResult = (msg, disc='') => ({
    estado_visual:'SIN_IMAGEN', analisis_visual:msg, estado_tecnico:'ERROR',
    validaciones:'', discrepancias:disc, recomendaciones:'', propuesta_correccion:''
  });

  if (!apiKey) return errResult('Falta ANTHROPIC_API_KEY.');
  if (scrape?.error && !scrape?.imagen) return errResult(
    `No se pudo scrapear: ${scrape?.error||'sin datos'}`, 'Falla del scraper.'
  );
  // Si hay error de scraper pero tenemos imagen, continuar con lo que hay

  const specs = { ...(scrape.especificaciones||{}) };
  const desc  = specs.__descripcion_larga__ || '';
  delete specs.__descripcion_larga__;
  delete specs.__sku_web__;

  // User message compacto — sin campos redundantes
  const payload = {
    texto_comercial: opts.descripcionMaestra || '',
    titulo_web:      scrape.titulo || '',
    descripcion_web: desc.slice(0, 400),  // limitar descripcion a 800 chars
    specs
  };

  const userText = 'Auditar producto famiq.com.ar:\n' +
    JSON.stringify(payload, null, 1) +   // indent=1 para menos tokens que indent=2
    '\nResponde SOLO el JSON indicado.';

  // Imagen
  const imgResult = scrape.imagen ? await fetchImageAsBase64(scrape.imagen) : null;

  // Si falló la descarga por error de red, retornar estado especial para reintentar
  if (imgResult?.downloadError) {
    return {
      estado_visual: 'ERROR_DESCARGA',
      analisis_visual: `No se pudo descargar la imagen (HTTP ${imgResult.status}): ${imgResult.message}. Pendiente de reintento.`,
      estado_tecnico: 'ERROR',
      validaciones: '', discrepancias: `[IMAGEN] Error de descarga HTTP ${imgResult.status}`,
      recomendaciones: '', propuesta_correccion: ''
    };
  }

  const messageContent = imgResult
    ? [{ type:'image', source:{ type:'base64', media_type:imgResult.mime, data:imgResult.data }},
       { type:'text', text:userText }]
    : userText;

  const MAX_RETRIES = 3;
  let lastErr = null;
  await throttledClaude();
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(ANTHROPIC_API_URL,
        { model:MODEL, max_tokens:700, system:[{ type:"text", text:SYSTEM_PROMPT, cache_control:{ type:"ephemeral" } }],
          messages:[{ role:'user', content:messageContent }] },
        { timeout:40000, headers:{
            'Content-Type':'application/json',
            'x-api-key':apiKey,
            'anthropic-version':'2023-06-01', 'anthropic-beta':'prompt-caching-2024-07-31'
          }}
      );
      const parsed = safeParseJson(res.data?.content?.[0]?.text || '');
      if (!parsed) { console.warn('[agent] JSON no parseable, stop_reason=' + (res.data?.stop_reason||'?') + ' texto=' + (res.data?.content?.[0]?.text||'').slice(0,200)); return errResult('Respuesta no parseable.'); } return normalize(parsed);
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const body   = err?.response?.data ? JSON.stringify(err.response.data) : '';
      console.warn(`[agent] Claude ${status} intento ${attempt}/${MAX_RETRIES}: ${body.slice(0,150)}`);
      if (new Set([429,529,503,502]).has(status) && attempt < MAX_RETRIES) {
        await sleep(10000 * attempt);
        continue;
      }
      break;
    }
  }
  const body = lastErr?.response?.data ? JSON.stringify(lastErr.response.data).slice(0,300) : '';
  return errResult(`Error Claude (${lastErr?.response?.status}): ${lastErr?.message}`, body||'Sin respuesta.');
}

export default auditScrape;
