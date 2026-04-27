// agent-batch.js — modo Batch API: submit + poll + retrieve, 50% más barato
// Doc: https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
import axios from 'axios';
import {
  ANTHROPIC_VERSION,
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

const BATCH_URL = 'https://api.anthropic.com/v1/messages/batches';

// Chunks chicos: respuestas legibles ante errores y evita timeouts en upload.
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_REQUESTS = 100;

const POLL_INTERVAL_MS = 60_000;          // chequear cada 60s
const MAX_POLL_DURATION_MS = 6 * 3_600_000; // 6 horas (matchea timeout del workflow)

function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': 'message-batches-2024-09-24'
  };
}

// ── Construcción de un request individual del batch ──────────────────────────

// Carga la imagen una sola vez por URL (cache local al run)
const imageBase64Cache = new Map();
async function getImageData(imageUrl) {
  if (!imageUrl) return null;
  if (imageBase64Cache.has(imageUrl)) return imageBase64Cache.get(imageUrl);
  const result = await fetchImageAsBase64(imageUrl);
  imageBase64Cache.set(imageUrl, result);
  return result;
}

// Devuelve el objeto request del batch, o null si no se puede armar
async function buildAuditRequest(customId, scrape, opts) {
  const payload = buildAuditPayload(scrape, opts);
  if (payload._earlyError) {
    return { _skipped: true, _earlyError: payload._earlyError };
  }
  const { userText, imageUrl } = payload;

  const imgResult = imageUrl ? await getImageData(imageUrl) : null;
  if (imgResult?.downloadError) {
    return {
      _skipped: true,
      _earlyError: {
        estado_visual: 'ERROR_DESCARGA',
        analisis_visual: `No se pudo descargar la imagen (HTTP ${imgResult.status}): ${imgResult.message}. Pendiente de reintento.`,
        estado_tecnico: 'ERROR',
        validaciones: '', discrepancias: `[IMAGEN] Error de descarga HTTP ${imgResult.status}`,
        recomendaciones: '', propuesta_correccion: '',
        estado_descripcion: 'SIN_DESCRIPCION', analisis_descripcion: ''
      }
    };
  }

  const content = imgResult
    ? [{ type:'image', source:{ type:'base64', media_type:imgResult.mime, data:imgResult.data } },
       { type:'text', text:userText }]
    : userText;

  // Sin imagen: usar prompt técnico para evitar que Claude responda en lenguaje natural
  const systemPrompt = imgResult ? SYSTEM_PROMPT_FULL : SYSTEM_PROMPT_TECHNICAL;

  return {
    custom_id: customId,
    params: {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: [{ type:'text', text: systemPrompt }],
      messages: [{ role:'user', content }]
    }
  };
}

async function buildVerifyRequest(customId, imageUrl, descripcionMaestra, initialAnalysis) {
  const imgResult = await getImageData(imageUrl);
  if (!imgResult || imgResult.downloadError) return null;

  const content = [
    { type:'image', source:{ type:'base64', media_type:imgResult.mime, data:imgResult.data } },
    { type:'text', text:
      'Producto declarado: ' + (descripcionMaestra || '') +
      '\nDiagnóstico inicial: ' + (initialAnalysis || '') +
      '\nResponde SOLO el JSON indicado.' }
  ];

  return {
    custom_id: customId,
    params: {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: [{ type:'text', text: SYSTEM_PROMPT_VERIFY }],
      messages: [{ role:'user', content }]
    }
  };
}

// ── Chunking: divide los requests en sub-batches que respeten el límite ─────

function chunkRequests(requests) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const req of requests) {
    const reqBytes = Buffer.byteLength(JSON.stringify(req), 'utf8');
    if (current.length >= MAX_BATCH_REQUESTS ||
        (current.length > 0 && currentBytes + reqBytes > MAX_BATCH_BYTES)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(req);
    currentBytes += reqBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Submit / poll / retrieve ────────────────────────────────────────────────

async function submitBatch(requests, apiKey) {
  const RETRYABLE = new Set([520, 529, 503, 502, 524]);
  const MAX_RETRIES = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(BATCH_URL, { requests }, {
        headers: authHeaders(apiKey),
        timeout: 120_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      // ECONNRESET: servidor cerró la conexión (puede tener status en err.request.res)
      const status = err?.response?.status ?? err?.request?.res?.statusCode;
      const detail = err?.response?.data
        ? JSON.stringify(err.response.data).slice(0, 300)
        : err?.message || '';
      console.warn(`[batch] submitBatch HTTP ${status||'?'} (${err?.code||'?'}) intento ${attempt}/${MAX_RETRIES}: ${detail}`);
      // No reintentar errores 4xx — son errores del cliente, no transitorios
      if (status && status >= 400 && status < 500) throw err;
      if (RETRYABLE.has(status) && attempt < MAX_RETRIES) {
        const wait = 15000 * attempt;
        console.log(`[batch] reintentando submitBatch en ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }
      // ECONNRESET sin status conocido: reintentar
      if (!status && err?.code === 'ECONNRESET' && attempt < MAX_RETRIES) {
        const wait = 15000 * attempt;
        console.log(`[batch] ECONNRESET sin status — reintentando en ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function getBatchStatus(batchId, apiKey) {
  const res = await axios.get(`${BATCH_URL}/${batchId}`, {
    headers: authHeaders(apiKey),
    timeout: 30_000
  });
  return res.data;
}

async function pollBatch(batchId, apiKey) {
  const start = Date.now();
  while (Date.now() - start < MAX_POLL_DURATION_MS) {
    const status = await getBatchStatus(batchId, apiKey);
    const counts = status.request_counts || {};
    console.log(`[batch ${batchId.slice(-8)}] ${status.processing_status} succ=${counts.succeeded||0} err=${counts.errored||0} canc=${counts.canceled||0} expir=${counts.expired||0} proc=${counts.processing||0}`);
    if (status.processing_status === 'ended') return status;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timeout esperando batch ${batchId} (${MAX_POLL_DURATION_MS/3600000}h)`);
}

// Descarga el archivo JSONL de resultados y devuelve { custom_id: parsedJson }
async function retrieveBatchResults(resultsUrl, apiKey) {
  const res = await axios.get(resultsUrl, {
    headers: authHeaders(apiKey),
    responseType: 'text',
    timeout: 300_000,
    maxContentLength: Infinity
  });
  const out = {};
  const lines = String(res.data).split('\n').filter(Boolean);
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const id = obj.custom_id;
    if (!id) continue;
    if (obj.result?.type === 'succeeded') {
      const text = obj.result.message?.content?.[0]?.text || '';
      out[id] = safeParseJson(text) || { _unparseable: text };
    } else if (obj.result?.type === 'errored') {
      out[id] = { _error: true, _errInfo: obj.result.error };
    } else if (obj.result?.type === 'canceled') {
      out[id] = { _error: true, _canceled: true };
    } else if (obj.result?.type === 'expired') {
      out[id] = { _error: true, _expired: true };
    }
  }
  return out;
}

// ── API pública: ejecuta auditoría completa en modo batch ───────────────────

/**
 * @param {Map<string, {scrape, opts}>} items  custom_id → datos de auditoría
 * @returns {Promise<Map<string, normalizedAudit>>}  custom_id → resultado
 */
export async function batchAudit(items, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY');

  const results = new Map();

  // ── Fase 1: armar requests (descarga imágenes con cache por URL) ──────────
  console.log(`[batch] armando ${items.size} requests...`);
  const requests = [];
  for (const [customId, { scrape, opts: itemOpts }] of items) {
    const req = await buildAuditRequest(customId, scrape, itemOpts || {});
    if (req?._skipped) {
      results.set(customId, normalize(req._earlyError));
      continue;
    }
    if (req) requests.push(req);
  }
  console.log(`[batch] ${requests.length} requests listos para submit (${results.size} pre-resueltos por error)`);

  // ── Fase 2: chunking ──────────────────────────────────────────────────────
  const chunks = chunkRequests(requests);
  console.log(`[batch] dividido en ${chunks.length} sub-batch${chunks.length>1?'es':''}`);
  chunks.forEach((c, i) => {
    const bytes = c.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r), 'utf8'), 0);
    console.log(`[batch]   sub-batch ${i+1}: ${c.length} requests, ${(bytes/1024/1024).toFixed(1)} MB`);
  });

  // ── Fase 3: submit en paralelo ────────────────────────────────────────────
  console.log(`[batch] submitiendo ${chunks.length} sub-batch(es) en paralelo...`);
  const submitted = await Promise.all(chunks.map(async (chunk, i) => {
    const r = await submitBatch(chunk, apiKey);
    console.log(`[batch] sub-batch ${i+1} submitido → id=${r.id}`);
    return r;
  }));

  // ── Fase 4: polling en paralelo ───────────────────────────────────────────
  console.log(`[batch] esperando finalización...`);
  const finished = await Promise.all(submitted.map(s => pollBatch(s.id, apiKey)));

  // ── Fase 5: retrieve ──────────────────────────────────────────────────────
  for (const status of finished) {
    if (!status.results_url) {
      console.warn(`[batch] ${status.id} sin results_url, status=${status.processing_status}`);
      continue;
    }
    const partial = await retrieveBatchResults(status.results_url, apiKey);
    for (const [id, audit] of Object.entries(partial)) {
      if (audit._error || audit._unparseable) {
        const msg = audit._unparseable ? 'JSON no parseable' :
                    audit._canceled    ? 'request cancelado' :
                    audit._expired     ? 'request expirado'  :
                    `Error Claude: ${audit._errInfo?.message || audit._errInfo?.type || 'sin detalle'}`;
        results.set(id, normalize({
          estado_visual: 'SIN_IMAGEN', analisis_visual: msg, estado_tecnico: 'ERROR',
          discrepancias: msg
        }));
      } else {
        results.set(id, normalize(audit));
      }
    }
  }
  console.log(`[batch] resultados primer pase: ${results.size} totales`);

  // ── Fase 6: 2-pass para los que dieron ERROR (deduplicado por imagen) ────
  const errorIds = [];
  for (const [id, r] of results) {
    if (r.estado_visual === 'ERROR') errorIds.push(id);
  }

  if (errorIds.length > 0) {
    console.log(`[batch] verificación 2-pass para ${errorIds.length} SKUs con ERROR...`);

    // dedup por URL de imagen — solo verificamos cada imagen única una vez
    const verifyByImage = new Map(); // imageUrl → { customId, descripcionMaestra, analysis }
    const errorImageOf = new Map();  // customId → imageUrl
    for (const id of errorIds) {
      const item = items.get(id);
      const imageUrl = item?.scrape?.imagen;
      if (!imageUrl) continue;
      errorImageOf.set(id, imageUrl);
      if (!verifyByImage.has(imageUrl)) {
        verifyByImage.set(imageUrl, {
          customId: id, // representante del grupo
          descripcionMaestra: item.opts?.descripcionMaestra,
          analysis: results.get(id).analisis_visual
        });
      }
    }
    console.log(`[batch] dedup: ${errorIds.length} ERRORs → ${verifyByImage.size} verificaciones únicas`);

    // armar verify requests
    const verifyReqs = [];
    for (const [imageUrl, info] of verifyByImage) {
      const req = await buildVerifyRequest(info.customId, imageUrl, info.descripcionMaestra, info.analysis);
      if (req) verifyReqs.push(req);
    }

    if (verifyReqs.length > 0) {
      try {
        const verifyChunks = chunkRequests(verifyReqs);
        const verifySubmitted = await Promise.all(verifyChunks.map((c, i) =>
          submitBatch(c, apiKey).then(r => {
            console.log(`[batch verify] sub-batch ${i+1} submitido → ${r.id}`);
            return r;
          })
        ));
        const verifyFinished = await Promise.all(verifySubmitted.map(s => pollBatch(s.id, apiKey)));
        const verifyResults = {};
        for (const v of verifyFinished) {
          if (!v.results_url) continue;
          Object.assign(verifyResults, await retrieveBatchResults(v.results_url, apiKey));
        }

        // mapear resultados de verify por imagen, luego propagar a todos los SKUs con esa imagen
        const verifyByImageResult = new Map();
        for (const [imageUrl, info] of verifyByImage) {
          const r = verifyResults[info.customId];
          if (r && !r._error && !r._unparseable) verifyByImageResult.set(imageUrl, r);
        }

        for (const [errorId, imageUrl] of errorImageOf) {
          const verify = verifyByImageResult.get(imageUrl);
          if (!verify) continue;
          const v = String(verify.estado_visual || '').toUpperCase();
          const conf = String(verify.confianza || '').toLowerCase();
          const original = results.get(errorId);
          if (v === 'COHERENTE') {
            original.estado_visual   = 'COHERENTE';
            original.analisis_visual = `[Verificado 2-pass batch, confianza ${conf||'?'}] ${verify.analisis_visual || ''}`.trim();
          } else {
            original.analisis_visual = `[Confirmado 2-pass batch, confianza ${conf||'?'}] ${original.analisis_visual}`;
          }
          results.set(errorId, original);
        }
        console.log(`[batch] verify aplicado a ${errorImageOf.size} SKUs`);
      } catch (verifyErr) {
        const detail = verifyErr?.response?.data
          ? JSON.stringify(verifyErr.response.data).slice(0, 300)
          : verifyErr?.message || 'sin detalle';
        console.warn(`[batch] verify 2-pass falló — manteniendo ERRORs originales. ${detail}`);
      }
    }
  }

  return results;
}

export default batchAudit;
