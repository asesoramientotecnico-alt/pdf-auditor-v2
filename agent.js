// agent.js
import axios from 'axios';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// v1beta soporta system_instruction y gemini-2.0-flash-001
const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-001:generateContent';

const SYSTEM_PROMPT = `Sos un Inspector de Oficina Tecnica de la empresa Famiq.
Tu trabajo es auditar fichas de producto publicadas en la web y detectar errores
antes de que lleguen al cliente final. Sos estricto, concreto y no inventas datos.

Se te entrega:
- texto_comercial_maestro: el nombre/descripcion oficial del producto segun el sistema interno de Famiq.
- titulo_web: el titulo tal como aparece publicado en famiq.com.ar.
- descripcion_larga_web: el texto descriptivo publicado en la pagina del producto.
- especificaciones_tecnicas: tabla de atributos tecnicos extraida de la pagina (medidas, normas, materiales, etc.).
- Una imagen del producto scrapeada de la pagina web (cuando esta disponible).

Tenes que validar TRES cosas:

A) COHERENCIA VISUAL (imagen vs texto_comercial_maestro):
   - La imagen publicada corresponde al producto que indica el texto_comercial_maestro?
   - Ejemplo de ERROR: el texto dice "MANGUERA ROSCADA DN 040 DIN 11851 - 304L" pero la imagen muestra otro tipo de fitting.
   - Si la imagen no se puede analizar, devolve estado_visual = "ERROR" y explicalo en analisis_visual.
   - Si no hay imagen disponible, devolve estado_visual = "SIN_IMAGEN".

B) CONSISTENCIA TEXTO COMERCIAL vs ESPECIFICACIONES TECNICAS:
   - Los valores numericos, materiales, normas y calibres de la tabla de especificaciones coinciden con lo que dice el texto_comercial_maestro?
   - Ejemplo de ERROR: texto_comercial_maestro dice "304L" pero especificaciones dicen "Material: AISI 316".
   - Ejemplo de ERROR: texto_comercial_maestro dice "DN040" pero especificaciones dicen "Diametro: 1 pulgada".
   - Revisar: material (304/304L/316/316L), diametro/calibre, norma (DAN/DIN/IEC/IRAM), tipo de conexion.

C) CONSISTENCIA TEXTO WEB vs ESPECIFICACIONES TECNICAS:
   - El titulo y descripcion publicados en la web coinciden con la tabla de especificaciones de esa misma pagina?
   - Detectar casos donde el texto web describe un producto pero las specs pertenecen a otro SKU.

ANOMALIAS A DETECTAR (ademas de los errores tecnicos):
- Descripcion o imagen de otro producto (copy-paste de SKU incorrecto).
- Norma tecnica incorrecta (ej: dice DAN pero deberia ser DIN 11851).
- Material incorrecto (ej: 304 vs 304L vs 316L).
- Titulo web que no coincide con texto_comercial_maestro.

RECOMENDACIONES:
- Si el producto esta OK pero el titulo web esta mal redactado o incompleto, indicarlo como recomendacion (no como error).
- Si hay informacion faltante en las especificaciones que deberia estar, indicarlo como recomendacion.

REGLAS DE SALIDA:
- Respondes EXCLUSIVAMENTE con un unico objeto JSON valido, sin texto extra, sin Markdown.
- Esquema EXACTO:
{
  "estado_visual": "COHERENTE" | "ERROR" | "SIN_IMAGEN",
  "analisis_visual": "descripcion breve de lo que muestra la imagen y si coincide",
  "estado_tecnico": "OK" | "ERROR",
  "discrepancias": "lista de discrepancias encontradas, o Sin discrepancias",
  "recomendaciones": "sugerencias de mejora aunque no sean errores criticos, o Sin recomendaciones",
  "propuesta_correccion": "que corregir exactamente, o No requiere correccion"
}`;

async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 20 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    let mimeType = (res.headers['content-type'] || '').split(';')[0].trim();
    if (!mimeType.startsWith('image/')) mimeType = 'image/jpeg';
    const buf = Buffer.from(res.data);
    if (buf.length > 3.5 * 1024 * 1024) {
      console.warn(`[agent] Imagen muy grande (${(buf.length / 1024 / 1024).toFixed(1)}MB), se auditara sin imagen.`);
      return null;
    }
    return { data: buf.toString('base64'), mimeType };
  } catch (err) {
    console.warn(`[agent] No se pudo obtener imagen: ${err?.message || err}`);
    return null;
  }
}

function safeParseJson(text) {
  if (!text) return null;
  let clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); } catch {}
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(clean.slice(first, last + 1)); } catch {}
  }
  return null;
}

function normalizeResult(raw) {
  const result = {
    estado_visual: 'ERROR',
    analisis_visual: '',
    estado_tecnico: 'ERROR',
    discrepancias: '',
    recomendaciones: '',
    propuesta_correccion: ''
  };
  if (!raw || typeof raw !== 'object') return result;

  const visual = String(raw.estado_visual || '').toUpperCase();
  if (visual === 'COHERENTE') result.estado_visual = 'COHERENTE';
  else if (visual === 'SIN_IMAGEN') result.estado_visual = 'SIN_IMAGEN';
  else result.estado_visual = 'ERROR';

  result.estado_tecnico = String(raw.estado_tecnico || '').toUpperCase() === 'OK' ? 'OK' : 'ERROR';
  result.analisis_visual = String(raw.analisis_visual || '').trim();
  result.discrepancias = String(raw.discrepancias || '').trim();
  result.recomendaciones = String(raw.recomendaciones || '').trim();
  result.propuesta_correccion = String(raw.propuesta_correccion || '').trim();
  return result;
}

/**
 * Espera ms milisegundos.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function auditScrape(scrape, opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      estado_visual: 'ERROR',
      analisis_visual: 'Falta GEMINI_API_KEY.',
      estado_tecnico: 'ERROR',
      discrepancias: '',
      recomendaciones: '',
      propuesta_correccion: ''
    };
  }

  if (!scrape || scrape.error) {
    return {
      estado_visual: 'ERROR',
      analisis_visual: `No se pudo scrapear: ${scrape?.error || 'sin datos'}`,
      estado_tecnico: 'ERROR',
      discrepancias: 'Falla del scraper.',
      recomendaciones: '',
      propuesta_correccion: 'Revisar URL del producto.'
    };
  }

  const especificacionesLimpias = { ...(scrape.especificaciones || {}) };
  const descripcionLarga = especificacionesLimpias.__descripcion_larga__ || '';
  delete especificacionesLimpias.__descripcion_larga__;

  const payload = {
    texto_comercial_maestro: opts.descripcionMaestra || '',
    titulo_web: scrape.titulo || '',
    url: scrape.url || '',
    descripcion_larga_web: descripcionLarga,
    especificaciones_tecnicas: especificacionesLimpias
  };

  const userText =
    'Auditar la siguiente ficha de producto de famiq.com.ar.\n' +
    JSON.stringify(payload, null, 2) +
    '\n\nResponde UNICAMENTE con el JSON del esquema indicado.';

  const parts = [{ text: userText }];

  const img = await fetchImageAsBase64(scrape.imagen);
  if (img) {
    parts.unshift({ inline_data: { data: img.data, mime_type: img.mimeType } });
  } else {
    parts.push({ text: 'No fue posible obtener la imagen del producto. Marcar estado_visual="SIN_IMAGEN".' });
  }

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1 }
  };

  // Reintentos con backoff exponencial para 429 (rate limit) y 503 (overload)
  const MAX_RETRIES = 5;
  const RETRY_CODES = new Set([429, 503, 502]);
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(
        `${GEMINI_API_URL}?key=${apiKey}`,
        body,
        { timeout: 60000, headers: { 'Content-Type': 'application/json' } }
      );

      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = safeParseJson(text);
      if (!parsed) {
        return {
          estado_visual: 'ERROR',
          analisis_visual: 'Respuesta no parseable.',
          estado_tecnico: 'ERROR',
          discrepancias: text.slice(0, 500),
          recomendaciones: '',
          propuesta_correccion: 'Revisar respuesta de Gemini.'
        };
      }
      return normalizeResult(parsed);

    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (RETRY_CODES.has(status) && attempt < MAX_RETRIES) {
        // Backoff: 15s, 30s, 60s, 120s
        const waitMs = 15000 * Math.pow(2, attempt - 1);
        console.warn(`[agent] Gemini ${status} (intento ${attempt}/${MAX_RETRIES}), esperando ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }
      break;
    }
  }

  // Agotamos reintentos
  const status = lastErr?.response?.status;
  const body2  = lastErr?.response?.data ? JSON.stringify(lastErr.response.data).slice(0, 400) : '';
  return {
    estado_visual: 'ERROR',
    analisis_visual: `Error Gemini (${status || 'red'}): ${lastErr?.message || lastErr}`,
    estado_tecnico: 'ERROR',
    discrepancias: body2 || 'No se obtuvo respuesta de Gemini.',
    recomendaciones: '',
    propuesta_correccion: 'Revisar API key, quota y endpoint.'
  };
}

export default auditScrape;
