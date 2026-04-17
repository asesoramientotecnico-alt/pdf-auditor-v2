// agent.js
import axios from 'axios';
import https from 'node:https';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

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

async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 40000,
        maxContentLength: 3 * 1024 * 1024,
        validateStatus: (s) => s >= 200 && s < 400,
        httpsAgent: insecureAgent,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const buf = Buffer.from(res.data);
      if (buf.length > 2.5 * 1024 * 1024) { console.warn(`[agent] imagen muy grande: ${buf.length}`); return null; }
      let mime = (res.headers['content-type'] || '').split(';')[0].trim();
      if (!mime.startsWith('image/')) mime = 'image/jpeg';
      console.log(`[agent] imagen ok (${buf.length} bytes)`);
      return { data: buf.toString('base64'), mime };
    } catch (err) {
      console.warn(`[agent] imagen intento ${attempt} error: ${err?.message?.slice(0,100)}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    }
  }
  return null;
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
    estado_visual:'SIN_IMAGEN', analisis_visual:'Sin respuesta parseable.', estado_tecnico:'ERROR',
    validaciones:'', discrepancias:'', recomendaciones:'', propuesta_correccion:''
  };
  const v = String(raw.estado_visual||'').toUpperCase();
  const t = String(raw.estado_tecnico||'').toUpperCase();
  return {
    estado_visual:        v==='COHERENTE'?'COHERENTE': v==='ERROR'?'ERROR':'SIN_IMAGEN',
    analisis_visual:      String(raw.analisis_visual      ||'').trim(),
    estado_tecnico:       t==='OK'?'OK':'ERROR',
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
  if (!scrape || scrape.error) return errResult(
    `No se pudo scrapear: ${scrape?.error||'sin datos'}`, 'Falla del scraper.'
  );

  const specs = { ...(scrape.especificaciones||{}) };
  const desc  = specs.__descripcion_larga__ || '';
  delete specs.__descripcion_larga__;
  delete specs.__sku_web__;

  // User message compacto — sin campos redundantes
  const payload = {
    texto_comercial: opts.descripcionMaestra || '',
    titulo_web:      scrape.titulo || '',
    descripcion_web: desc.slice(0, 800),  // limitar descripcion a 800 chars
    specs
  };

  const userText = 'Auditar producto famiq.com.ar:\n' +
    JSON.stringify(payload, null, 1) +   // indent=1 para menos tokens que indent=2
    '\nResponde SOLO el JSON indicado.';

  // Imagen — opcional, no bloquea validación técnica
  let img = null;
  if (scrape.imagen) {
    img = await fetchImageAsBase64(scrape.imagen);
    if (!img) console.warn(`[agent] imagen no disponible, continúa sin visual`);
  }

  const messageContent = img
    ? [{ type:'image', source:{ type:'base64', media_type:img.mime, data:img.data }},
       { type:'text', text:userText }]
    : userText;

  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(ANTHROPIC_API_URL,
        { model:MODEL, max_tokens:1024, system:SYSTEM_PROMPT,
          messages:[{ role:'user', content:messageContent }] },
        { timeout:40000, headers:{
            'Content-Type':'application/json',
            'x-api-key':apiKey,
            'anthropic-version':'2023-06-01'
          }}
      );
      const parsed = safeParseJson(res.data?.content?.[0]?.text || '');
      return parsed ? normalize(parsed) : errResult('Respuesta no parseable.');
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
