// agent.js
import axios from 'axios';
import https from 'node:https';
import sharp from 'sharp';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

// Throttle: 5 req/min = 1 cada 13s (margen sobre los 12s exactos)
// Cola de tiempo reservado: cada llamada toma un slot aunque lleguen simultáneas
const MIN_CALL_INTERVAL_MS = 13000;
let _nextCallTime = 0;
async function throttledClaude() {
  const now = Date.now();
  const callTime = Math.max(now, _nextCallTime);
  _nextCallTime = callTime + MIN_CALL_INTERVAL_MS;
  const wait = callTime - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

// Prompt completo: visual + técnico (se usa la primera vez que aparece una imagen)
const SYSTEM_PROMPT_FULL = `Inspector de Oficina Tecnica de Famiq. Auditas fichas de producto web.

Inputs:
- texto_comercial: nombre oficial interno (FUENTE DE VERDAD)
- titulo_web: titulo publicado en famiq.com.ar
- specs: tabla de especificaciones tecnicas
- imagen adjunta: foto del producto tomada de la columna M del inventario

REGLA CRITICA PARA IMAGEN:
- Si recibes una imagen adjunta en este mensaje: DEBES evaluarla. Usa COHERENTE si muestra el producto correcto segun texto_comercial, o ERROR si muestra otro producto o es incorrecta. NUNCA uses SIN_IMAGEN si recibes una imagen.
- Solo usa SIN_IMAGEN si el mensaje NO contiene imagen adjunta.

Validar:
A) VISUAL: la imagen adjunta corresponde al texto_comercial? (COHERENTE/ERROR/SIN_IMAGEN segun regla)
B) TECNICO texto_comercial vs specs: material (304/304L/316/316L), diametro (mm/DN/pulg), norma (DAN/DIN/SMS/SCH), conexion. Campo por campo.
C) TEXTO WEB vs specs: titulo_web coincide con specs?

Errores criticos: material wrong, diametro wrong, norma wrong, imagen de otro producto, specs de otro SKU.
Recomendaciones: titulo mal redactado, specs incompletas, descripcion generica.

Responde SOLO JSON valido:
{"estado_visual":"COHERENTE"|"ERROR"|"SIN_IMAGEN","analisis_visual":"texto","estado_tecnico":"OK"|"ERROR","validaciones":"campo:maestro=X tabla=Y OK/ERR | ...","discrepancias":"lista o Sin discrepancias","recomendaciones":"lista o Sin recomendaciones","propuesta_correccion":"texto o No requiere correccion"}`;

// Prompt técnico: sin imagen (se usa cuando la imagen ya fue evaluada y está en caché)
const SYSTEM_PROMPT_TECHNICAL = `Inspector de Oficina Tecnica de Famiq. Auditas fichas de producto web.

Inputs:
- texto_comercial: nombre oficial interno (FUENTE DE VERDAD)
- titulo_web: titulo publicado en famiq.com.ar
- specs: tabla de especificaciones tecnicas

Validar SOLO la parte tecnica (sin imagen):
B) TECNICO texto_comercial vs specs: material (304/304L/316/316L), diametro (mm/DN/pulg), norma (DAN/DIN/SMS/SCH), conexion. Campo por campo.
C) TEXTO WEB vs specs: titulo_web coincide con specs?

Errores criticos: material wrong, diametro wrong, norma wrong, specs de otro SKU.
Recomendaciones: titulo mal redactado, specs incompletas.

Responde SOLO JSON valido:
{"estado_tecnico":"OK"|"ERROR","validaciones":"campo:maestro=X tabla=Y OK/ERR | ...","discrepancias":"lista o Sin discrepancias","recomendaciones":"lista o Sin recomendaciones","propuesta_correccion":"texto o No requiere correccion"}`;

// Prompt de verificación visual: sólo se usa cuando la primera revisión dio ERROR.
// Sesgo conservador → prefiere COHERENTE ante duda razonable.
const SYSTEM_PROMPT_VERIFY = `Inspector visual senior de Famiq. Una primera revisión IA sugirió que la imagen NO corresponde al producto declarado. Tu tarea es verificar críticamente ese diagnóstico antes de confirmarlo como ERROR.

Reglas para la verificación:
1. La calidad de la foto puede ser baja (thumbnail). No descartes el producto sólo porque cuesta verlo.
2. Componentes accesorios (actuadores, conexiones, soportes, manómetros) suelen tapar partes distintivas del producto principal. Eso no implica que el producto sea otro.
3. Tipos similares pueden verse parecidos a baja resolución (mariposa vs bola con actuador, codo vs T desde un ángulo, conexion SMS vs DIN).
4. Solo CONFIRMA ERROR si ves CLARAMENTE caracteristicas que CONTRADICEN el producto declarado (ej: sin duda es una bomba en vez de una valvula, o claramente es un caño recto cuando deberia ser un codo).
5. Si tenes cualquier duda razonable o la foto no permite descartar el producto declarado: respondé COHERENTE.

Responde SOLO JSON valido:
{"estado_visual":"COHERENTE"|"ERROR","analisis_visual":"justificacion detallada de por que confirmas o cambias el diagnostico","confianza":"alta"|"media"|"baja"}`;

// Cache visual en memoria: image_url -> { estado_visual, analisis_visual }
// Garantiza que la misma foto siempre recibe el mismo diagnóstico visual en una ejecución
const visualCache = new Map();

async function resizeImage(buf) {
  try {
    const MAX_PX = 640;
    const img = sharp(buf);
    const meta = await img.metadata();
    if ((meta.width || 0) <= MAX_PX && (meta.height || 0) <= MAX_PX) return { buf, mime: null };
    const out = await img
      .resize(MAX_PX, MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    console.log(`[agent] resize ${meta.width}x${meta.height}→≤${MAX_PX}px (${out.length}b)`);
    return { buf: out, mime: 'image/jpeg' };
  } catch (e) {
    console.warn(`[agent] resize skip: ${e?.message?.slice(0, 60)}`);
    return { buf, mime: null };
  }
}

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
      const rawBuf = Buffer.from(res.data);
      if (rawBuf.length > 2.5 * 1024 * 1024) { console.warn(`[agent] imagen muy grande: ${rawBuf.length}`); return null; }
      let mime = (res.headers['content-type'] || '').split(';')[0].trim();
      if (!mime.startsWith('image/')) mime = 'image/jpeg';
      const resized = await resizeImage(rawBuf);
      const buf = resized.buf;
      if (resized.mime) mime = resized.mime;
      console.log(`[agent] imagen ok (${buf.length} bytes)`);
      return { data: buf.toString('base64'), mime };
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      console.warn(`[agent] imagen intento ${attempt}/3 error HTTP ${status || 'red'}: ${err?.message?.slice(0,100)}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
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

// Llama a Claude con reintentos. Devuelve el objeto JSON parseado o null en error.
async function callClaude(systemPrompt, messageContent, apiKey) {
  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(
        ANTHROPIC_API_URL,
        {
          model: MODEL,
          max_tokens: 700,
          temperature: 0,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: messageContent }]
        },
        {
          timeout: 40000,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'prompt-caching-2024-07-31'
          }
        }
      );
      const parsed = safeParseJson(res.data?.content?.[0]?.text || '');
      if (!parsed) {
        console.warn('[agent] JSON no parseable, stop_reason=' + (res.data?.stop_reason||'?') +
          ' texto=' + (res.data?.content?.[0]?.text||'').slice(0,200));
        return null;
      }
      return parsed;
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
  return { _error: true, _lastErr: lastErr };
}

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

  const specs = { ...(scrape.especificaciones||{}) };
  delete specs.__descripcion_larga__;
  delete specs.__sku_web__;

  const userText = 'Auditar producto famiq.com.ar:\n' +
    JSON.stringify({ texto_comercial: opts.descripcionMaestra||'', titulo_web: scrape.titulo||'', specs }, null, 1) +
    '\nResponde SOLO el JSON indicado.';

  const imageUrl = scrape.imagen || null;

  // ── RUTA A: imagen ya evaluada en esta ejecución ──────────────────────────
  // Usa el resultado visual cacheado + llama solo para la parte técnica (sin imagen, más barato)
  if (imageUrl && visualCache.has(imageUrl)) {
    const cached = visualCache.get(imageUrl);
    console.log(`[agent] visual cache hit → ${imageUrl.slice(-55)}`);
    await throttledClaude();
    const tech = await callClaude(SYSTEM_PROMPT_TECHNICAL, userText, apiKey);
    if (!tech || tech._error) {
      const body = tech?._lastErr?.response?.data ? JSON.stringify(tech._lastErr.response.data).slice(0,300) : '';
      return errResult(`Error Claude técnico: ${tech?._lastErr?.message}`, body||'Sin respuesta.');
    }
    return normalize({ ...tech, estado_visual: cached.estado_visual, analisis_visual: cached.analisis_visual });
  }

  // ── RUTA B: imagen nueva o sin imagen → llamada completa ─────────────────
  const imgResult = imageUrl ? await fetchImageAsBase64(imageUrl) : null;

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

  await throttledClaude();
  const full = await callClaude(SYSTEM_PROMPT_FULL, messageContent, apiKey);

  if (!full || full._error) {
    const body = full?._lastErr?.response?.data ? JSON.stringify(full._lastErr.response.data).slice(0,300) : '';
    return errResult(`Error Claude (${full?._lastErr?.response?.status}): ${full?._lastErr?.message}`, body||'Sin respuesta.');
  }

  const result = normalize(full);

  // ── Verificación 2-pass: si la primera revisión dijo ERROR, mirar de nuevo
  // con prompt crítico antes de confirmar. Reduce falsos positivos en imágenes ambiguas.
  if (result.estado_visual === 'ERROR' && imgResult) {
    console.log(`[agent] visual=ERROR → 2-pass verificación...`);
    const verifyContent = [
      { type: 'image', source: { type: 'base64', media_type: imgResult.mime, data: imgResult.data } },
      { type: 'text', text:
        'Producto declarado: ' + (opts.descripcionMaestra || '') +
        '\nDiagnóstico inicial: ' + (result.analisis_visual || '') +
        '\nResponde SOLO el JSON indicado.' }
    ];
    await throttledClaude();
    const verify = await callClaude(SYSTEM_PROMPT_VERIFY, verifyContent, apiKey);
    if (verify && !verify._error) {
      const v = String(verify.estado_visual || '').toUpperCase();
      const conf = String(verify.confianza || '').toLowerCase();
      if (v === 'COHERENTE') {
        console.log(`[agent] 2-pass: ERROR → COHERENTE (confianza: ${conf||'?'})`);
        result.estado_visual   = 'COHERENTE';
        result.analisis_visual = `[Verificado 2-pass, confianza ${conf||'?'}] ${verify.analisis_visual || ''}`.trim();
      } else {
        console.log(`[agent] 2-pass: ERROR confirmado (confianza: ${conf||'?'})`);
        result.analisis_visual = `[Confirmado 2-pass, confianza ${conf||'?'}] ${result.analisis_visual}`;
      }
    } else {
      console.warn('[agent] 2-pass falló — manteniendo ERROR del primer pase');
    }
  }

  // Guardar en caché visual el resultado FINAL (post-verificación), no el primer pase.
  if (imageUrl && result.estado_visual !== 'ERROR_DESCARGA') {
    visualCache.set(imageUrl, { estado_visual: result.estado_visual, analisis_visual: result.analisis_visual });
    console.log(`[agent] visual cacheada: ${result.estado_visual} → ${imageUrl.slice(-55)}`);
  }

  return result;
}

export default auditScrape;
