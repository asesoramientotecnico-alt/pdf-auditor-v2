// agent.js
import axios from 'axios';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

Tenes que validar DOS cosas:

A) CONSISTENCIA TEXTO COMERCIAL vs ESPECIFICACIONES TECNICAS:
   - Los valores numericos, materiales, normas y calibres de la tabla de especificaciones coinciden
     con lo que dice el texto_comercial_maestro?
   - Revisar especialmente: material (304/304L/316/316L), diametro/calibre (DN, pulgadas, mm),
     norma (DAN/DIN 11851/IEC/IRAM), tipo de conexion (roscada, soldada, clamp).
   - Ejemplo de ERROR: texto_comercial_maestro dice "304L" pero especificaciones dicen "Material: AISI 316".
   - Ejemplo de ERROR: texto_comercial_maestro dice "DN040" pero especificaciones dicen "Diametro: DN025".

B) CONSISTENCIA TEXTO WEB vs ESPECIFICACIONES TECNICAS:
   - El titulo_web y la descripcion_larga_web coinciden con la tabla de especificaciones de esa pagina?
   - Detectar casos donde el texto web describe un producto pero las specs pertenecen a otro SKU.
   - Detectar si el titulo_web no coincide con el texto_comercial_maestro (puede indicar producto mal cargado).

ANOMALIAS A DETECTAR:
- Material incorrecto (304 vs 304L vs 316 vs 316L).
- Diametro/calibre incorrecto o inconsistente entre texto y specs.
- Norma tecnica incorrecta (ej: dice DAN pero specs dicen DIN 11851).
- Titulo web distinto al texto comercial maestro (posible SKU equivocado).
- Especificaciones vacias o insuficientes (faltan datos clave como material, diametro o norma).
- Descripcion larga que no corresponde al producto del titulo.

RECOMENDACIONES (no son errores criticos pero conviene corregir):
- Titulo web mal redactado o abreviado respecto al texto comercial maestro.
- Especificaciones incompletas (faltan campos como presion de trabajo, temperatura, acabado).
- Descripcion larga demasiado generica o copiada de otro producto similar.

REGLAS DE SALIDA:
- Respondes EXCLUSIVAMENTE con un unico objeto JSON valido, sin texto extra, sin Markdown.
- Esquema EXACTO:
{
  "estado_tecnico": "OK" | "ERROR",
  "discrepancias": "lista detallada de discrepancias encontradas, o Sin discrepancias",
  "recomendaciones": "sugerencias de mejora aunque no sean errores criticos, o Sin recomendaciones",
  "propuesta_correccion": "que corregir exactamente, o No requiere correccion"
}`;

function safeParseJson(text) {
  if (!text) return null;
  let clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); } catch {}
  const first = clean.indexOf('{');
  const last  = clean.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(clean.slice(first, last + 1)); } catch {}
  }
  return null;
}

function normalizeResult(raw) {
  const result = {
    estado_visual:      'SIN_IMAGEN',
    analisis_visual:    'Auditoria solo de texto (sin imagen).',
    estado_tecnico:     'ERROR',
    discrepancias:      '',
    recomendaciones:    '',
    propuesta_correccion: ''
  };
  if (!raw || typeof raw !== 'object') return result;
  result.estado_tecnico      = String(raw.estado_tecnico || '').toUpperCase() === 'OK' ? 'OK' : 'ERROR';
  result.discrepancias       = String(raw.discrepancias       || '').trim();
  result.recomendaciones     = String(raw.recomendaciones     || '').trim();
  result.propuesta_correccion = String(raw.propuesta_correccion || '').trim();
  return result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function auditScrape(scrape, opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      estado_visual: 'SIN_IMAGEN', analisis_visual: 'Falta GEMINI_API_KEY.',
      estado_tecnico: 'ERROR', discrepancias: '', recomendaciones: '', propuesta_correccion: ''
    };
  }

  if (!scrape || scrape.error) {
    return {
      estado_visual: 'SIN_IMAGEN', analisis_visual: `No se pudo scrapear: ${scrape?.error || 'sin datos'}`,
      estado_tecnico: 'ERROR', discrepancias: 'Falla del scraper.',
      recomendaciones: '', propuesta_correccion: 'Revisar URL del producto.'
    };
  }

  const especificacionesLimpias = { ...(scrape.especificaciones || {}) };
  const descripcionLarga = especificacionesLimpias.__descripcion_larga__ || '';
  delete especificacionesLimpias.__descripcion_larga__;

  const payload = {
    texto_comercial_maestro:   opts.descripcionMaestra || '',
    titulo_web:                scrape.titulo || '',
    url:                       scrape.url || '',
    descripcion_larga_web:     descripcionLarga,
    especificaciones_tecnicas: especificacionesLimpias
  };

  const userText =
    'Auditar la siguiente ficha de producto de famiq.com.ar.\n' +
    JSON.stringify(payload, null, 2) +
    '\n\nResponde UNICAMENTE con el JSON del esquema indicado.';

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.1 }
  };

  const MAX_RETRIES  = 5;
  const RETRY_CODES  = new Set([429, 503, 502]);
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(
        `${GEMINI_API_URL}?key=${apiKey}`,
        body,
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
      );

      const text   = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = safeParseJson(text);
      if (!parsed) {
        return {
          estado_visual: 'SIN_IMAGEN', analisis_visual: 'Respuesta no parseable.',
          estado_tecnico: 'ERROR', discrepancias: text.slice(0, 500),
          recomendaciones: '', propuesta_correccion: 'Revisar respuesta de Gemini.'
        };
      }
      return normalizeResult(parsed);

    } catch (err) {
      lastErr = err;
      const status  = err?.response?.status;
      const errBody = err?.response?.data ? JSON.stringify(err.response.data) : '';
      console.warn(`[agent] Gemini ${status} intento ${attempt}/${MAX_RETRIES}: ${errBody.slice(0, 200)}`);

      if (RETRY_CODES.has(status) && attempt < MAX_RETRIES) {
        const waitMs = 15000 * Math.pow(2, attempt - 1); // 15s, 30s, 60s, 120s
        console.warn(`[agent] Esperando ${waitMs / 1000}s antes de reintentar...`);
        await sleep(waitMs);
        continue;
      }
      break;
    }
  }

  const status = lastErr?.response?.status;
  const body2  = lastErr?.response?.data ? JSON.stringify(lastErr.response.data).slice(0, 500) : '';
  return {
    estado_visual: 'SIN_IMAGEN', analisis_visual: `Error Gemini (${status}): ${lastErr?.message || lastErr}`,
    estado_tecnico: 'ERROR', discrepancias: body2 || 'Sin respuesta de Gemini.',
    recomendaciones: '', propuesta_correccion: 'Revisar API key y quota.'
  };
}

export default auditScrape;
