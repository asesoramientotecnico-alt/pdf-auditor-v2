// agent.js
import axios from 'axios';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Sos un Inspector de Oficina Tecnica de la empresa Famiq.
Tu trabajo es auditar fichas de producto publicadas en la web y detectar errores
antes de que lleguen al cliente final. Sos estricto, concreto y no inventas datos.

Se te entrega:
- texto_comercial_maestro: descripcion oficial del producto segun el sistema interno de Famiq. ES LA FUENTE DE VERDAD.
- titulo_web: titulo publicado en famiq.com.ar.
- descripcion_larga_web: texto descriptivo publicado en la pagina.
- especificaciones_tecnicas: tabla de atributos tecnicos extraida de la pagina (medidas, normas, materiales, etc.).
- imagen_disponible: true/false — si hay imagen del carrusel para analizar visualmente.

Cuando imagen_disponible=true, se incluye la imagen del carrusel como primer elemento del mensaje.

Tenes que validar TRES cosas:

A) COHERENCIA VISUAL (solo si hay imagen):
   - El producto que se ve en la imagen corresponde al texto_comercial_maestro?
   - Ejemplo de ERROR: texto dice "STUB END para soldar 316L" pero la imagen muestra una valvula.
   - Detectar si la imagen parece ser de otro producto o familia completamente diferente.
   - Si no hay imagen: estado_visual = "SIN_IMAGEN".

B) CONSISTENCIA TEXTO COMERCIAL vs ESPECIFICACIONES TECNICAS:
   - Los valores numericos, materiales, normas y calibres de la tabla coinciden con texto_comercial_maestro?
   - Revisar: material (304/304L/316/316L), diametro/calibre (DN, mm, pulgadas),
     norma (DAN/DIN 11851/SMS/IEC/IRAM/SCH), tipo de conexion (roscada, soldada, clamp, stub end).
   - Ejemplo ERROR: maestro dice "316L" pero specs dicen "Calidad: 304".
   - Ejemplo ERROR: maestro dice "73,0 x 3,05 mm" pero specs dicen "Diametro: 50,8 mm".

C) CONSISTENCIA TITULO WEB vs ESPECIFICACIONES TECNICAS:
   - El titulo_web y descripcion_larga_web coinciden con la tabla de la pagina?
   - Detectar si titulo_web difiere significativamente del texto_comercial_maestro.

ANOMALIAS CRITICAS A DETECTAR:
- Material incorrecto (304 vs 304L vs 316 vs 316L).
- Diametro/espesor de pared incorrecto.
- Norma tecnica incorrecta.
- Titulo web que no corresponde al texto comercial maestro.
- Imagen de otro producto o familia.
- Especificaciones vacias o de otro SKU.

RECOMENDACIONES (no criticas pero conviene corregir):
- Titulo web mal redactado o incompleto vs texto comercial maestro.
- Especificaciones incompletas (falta presion trabajo, temperatura, acabado superficial).
- Descripcion larga generica o copiada de otro producto.

REGLAS DE SALIDA:
- Respondes EXCLUSIVAMENTE con un unico objeto JSON valido, sin texto extra, sin Markdown.
- Esquema EXACTO:
{
  "estado_visual": "COHERENTE" | "ERROR" | "SIN_IMAGEN",
  "analisis_visual": "que muestra la imagen y si corresponde al producto, o 'Sin imagen disponible'",
  "estado_tecnico": "OK" | "ERROR",
  "validaciones": "campo por campo: 'material: maestro=316L tabla=316L OK | diametro: maestro=73.0mm tabla=73.0mm OK | norma: maestro=SCH.10 tabla=SCH10 OK'",
  "discrepancias": "lista detallada de discrepancias, o Sin discrepancias",
  "recomendaciones": "sugerencias de mejora, o Sin recomendaciones",
  "propuesta_correccion": "que corregir exactamente, o No requiere correccion"
}`;

async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 4 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const buf = Buffer.from(res.data);
    // Limitar a 3.5MB para no exceder límite de Anthropic
    if (buf.length > 3.5 * 1024 * 1024) {
      console.warn(`[agent] Imagen grande (${(buf.length/1024/1024).toFixed(1)}MB), auditando sin imagen`);
      return null;
    }
    let mimeType = (res.headers['content-type'] || '').split(';')[0].trim();
    if (!mimeType.startsWith('image/')) mimeType = 'image/jpeg';
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
  const last  = clean.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(clean.slice(first, last + 1)); } catch {}
  }
  return null;
}

function normalizeResult(raw) {
  const result = {
    estado_visual:        'SIN_IMAGEN',
    analisis_visual:      'Sin imagen disponible.',
    estado_tecnico:       'ERROR',
    discrepancias:        '',
    validaciones:         '',
    recomendaciones:      '',
    propuesta_correccion: ''
  };
  if (!raw || typeof raw !== 'object') return result;
  const visual = String(raw.estado_visual || '').toUpperCase();
  if (visual === 'COHERENTE') result.estado_visual = 'COHERENTE';
  else if (visual === 'ERROR') result.estado_visual = 'ERROR';
  else result.estado_visual = 'SIN_IMAGEN';
  result.analisis_visual      = String(raw.analisis_visual      || '').trim();
  result.estado_tecnico       = String(raw.estado_tecnico       || '').toUpperCase() === 'OK' ? 'OK' : 'ERROR';
  result.validaciones         = String(raw.validaciones         || '').trim();
  result.discrepancias        = String(raw.discrepancias        || '').trim();
  result.recomendaciones      = String(raw.recomendaciones      || '').trim();
  result.propuesta_correccion = String(raw.propuesta_correccion || '').trim();
  return result;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function auditScrape(scrape, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      estado_visual: 'SIN_IMAGEN', analisis_visual: 'Falta ANTHROPIC_API_KEY.',
      estado_tecnico: 'ERROR', discrepancias: '',
      validaciones: '', recomendaciones: '', propuesta_correccion: ''
    };
  }

  if (!scrape || scrape.error) {
    return {
      estado_visual: 'SIN_IMAGEN', analisis_visual: `No se pudo scrapear: ${scrape?.error || 'sin datos'}`,
      estado_tecnico: 'ERROR', discrepancias: 'Falla del scraper.',
      validaciones: '', recomendaciones: '', propuesta_correccion: 'Revisar URL del producto.'
    };
  }

  const especificacionesLimpias = { ...(scrape.especificaciones || {}) };
  const descripcionLarga = especificacionesLimpias.__descripcion_larga__ || '';
  delete especificacionesLimpias.__descripcion_larga__;
  delete especificacionesLimpias.__sku_web__;

  // Intentar obtener imagen
  const img = scrape.imagen ? await fetchImageAsBase64(scrape.imagen) : null;

  const userTextContent = {
    texto_comercial_maestro:   opts.descripcionMaestra || '',
    titulo_web:                scrape.titulo || '',
    url:                       scrape.url || '',
    descripcion_larga_web:     descripcionLarga,
    especificaciones_tecnicas: especificacionesLimpias,
    imagen_disponible:         img !== null
  };

  const userText =
    'Auditar la siguiente ficha de producto de famiq.com.ar.\n' +
    JSON.stringify(userTextContent, null, 2) +
    '\n\nResponde UNICAMENTE con el JSON del esquema indicado.';

  // Construir partes del mensaje — imagen primero si existe
  let messageContent;
  if (img) {
    messageContent = [
      { type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } },
      { type: 'text', text: userText }
    ];
  } else {
    messageContent = userText;
  }

  const MAX_RETRIES = 4;
  const RETRY_CODES = new Set([429, 529, 503, 502]);
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(
        ANTHROPIC_API_URL,
        {
          model:      MODEL,
          max_tokens: 1024,
          system:     SYSTEM_PROMPT,
          messages:   [{ role: 'user', content: messageContent }]
        },
        {
          timeout: 45000,
          headers: {
            'Content-Type':      'application/json',
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01'
          }
        }
      );

      const text   = res.data?.content?.[0]?.text || '';
      const parsed = safeParseJson(text);
      if (!parsed) {
        return {
          estado_visual: 'SIN_IMAGEN', analisis_visual: 'Respuesta no parseable.',
          estado_tecnico: 'ERROR', discrepancias: text.slice(0, 500),
          validaciones: '', recomendaciones: '', propuesta_correccion: 'Revisar respuesta de Claude.'
        };
      }
      return normalizeResult(parsed);

    } catch (err) {
      lastErr = err;
      const status  = err?.response?.status;
      const errBody = err?.response?.data ? JSON.stringify(err.response.data) : '';
      console.warn(`[agent] Claude ${status} intento ${attempt}/${MAX_RETRIES}: ${errBody.slice(0, 200)}`);
      if (RETRY_CODES.has(status) && attempt < MAX_RETRIES) {
        const waitMs = 10000 * attempt;
        console.warn(`[agent] Esperando ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }
      break;
    }
  }

  const status = lastErr?.response?.status;
  const body2  = lastErr?.response?.data ? JSON.stringify(lastErr.response.data).slice(0, 500) : '';
  return {
    estado_visual: 'SIN_IMAGEN', analisis_visual: `Error Claude (${status}): ${lastErr?.message || lastErr}`,
    estado_tecnico: 'ERROR', discrepancias: body2 || 'Sin respuesta.',
    validaciones: '', recomendaciones: '', propuesta_correccion: 'Revisar ANTHROPIC_API_KEY.'
  };
}

export default auditScrape;
