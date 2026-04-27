// agent.js — modo síncrono (1 llamada por SKU, throttle 13s)
import axios from 'axios';
import {
  ANTHROPIC_VERSION,
  ANTHROPIC_BETA,
  MODEL,
  MAX_TOKENS,
  SYSTEM_PROMPT_FULL,
  SYSTEM_PROMPT_TECHNICAL,
  SYSTEM_PROMPT_VERIFY,
  fetchImageAsBase64,
  safeParseJson,
  normalize,
  buildAuditPayload,
  sleep
} from './agent-common.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Throttle: 5 req/min = 1 cada 13s (margen sobre los 12s exactos)
const MIN_CALL_INTERVAL_MS = 13000;
let _nextCallTime = 0;
async function throttledClaude() {
  const now = Date.now();
  const callTime = Math.max(now, _nextCallTime);
  _nextCallTime = callTime + MIN_CALL_INTERVAL_MS;
  const wait = callTime - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

// Cache visual en memoria: image_url -> { estado_visual, analisis_visual }
const visualCache = new Map();

async function callClaude(systemPrompt, messageContent, apiKey) {
  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(
        ANTHROPIC_API_URL,
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: messageContent }]
        },
        {
          timeout: 40000,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': ANTHROPIC_BETA
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
    validaciones:'', discrepancias:disc, recomendaciones:'', propuesta_correccion:'',
    estado_descripcion:'SIN_DESCRIPCION', analisis_descripcion:''
  });

  if (!apiKey) return errResult('Falta ANTHROPIC_API_KEY.');

  const payload = buildAuditPayload(scrape, opts);
  if (payload._earlyError) return payload._earlyError;
  const { userText, imageUrl } = payload;

  // ── RUTA A: imagen ya evaluada en esta ejecución → reutilizar visual cacheado
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

  // ── RUTA B: imagen nueva o sin imagen → llamada completa ────────────────────
  const imgResult = imageUrl ? await fetchImageAsBase64(imageUrl) : null;

  if (imgResult?.downloadError) {
    return {
      estado_visual: 'ERROR_DESCARGA',
      analisis_visual: `No se pudo descargar la imagen (HTTP ${imgResult.status}): ${imgResult.message}. Pendiente de reintento.`,
      estado_tecnico: 'ERROR',
      validaciones: '', discrepancias: `[IMAGEN] Error de descarga HTTP ${imgResult.status}`,
      recomendaciones: '', propuesta_correccion: '',
      estado_descripcion: 'SIN_DESCRIPCION', analisis_descripcion: ''
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

  // ── Verificación 2-pass si la primera revisión dijo ERROR
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

  if (imageUrl && result.estado_visual !== 'ERROR_DESCARGA' && result.estado_visual !== 'SIN_IMAGEN') {
    visualCache.set(imageUrl, { estado_visual: result.estado_visual, analisis_visual: result.analisis_visual });
    console.log(`[agent] visual cacheada: ${result.estado_visual} → ${imageUrl.slice(-55)}`);
  }

  return result;
}

export default auditScrape;
