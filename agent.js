// agent.js
// Recibe el JSON producido por scraper.js y actua como Inspector de Oficina Tecnica.
// Valida:
//   A) Coherencia Visual: imagen principal vs titulo/descripcion.
//   B) Consistencia Numerica: medidas/normas listadas vs descripcion del producto.
// Retorna un JSON estricto con el resultado.

import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const MODEL_ID = 'gemini-2.0-flash';

const SYSTEM_PROMPT = `Sos un Inspector de Oficina Tecnica de la empresa Famiq.
Tu trabajo es auditar fichas de producto publicadas en la web y detectar errores
antes de que lleguen al cliente final. Sos estricto, concreto y no inventas datos.

Se te entrega:
- Una imagen del producto publicada en la web.
- El texto descriptivo (titulo y descripcion larga) publicado junto a la imagen.
- Una tabla de especificaciones tecnicas (medidas, normas IRAM/IEC, materiales, etc.)
  tambien publicada en la misma pagina.

Tenes que validar dos cosas:

A) COHERENCIA VISUAL:
   - La imagen muestra lo mismo que dice el titulo/descripcion?
   - Si dice "caja estanca IP65 de 4 modulos" pero la imagen es un interruptor,
     es un ERROR.
   - Si la imagen no se puede analizar por algun motivo, devolve estado "ERROR"
     y explicalo en analisis_visual.

B) CONSISTENCIA NUMERICA / TECNICA:
   - Las medidas, calibres, normas, grados IP y materiales que aparecen en la
     tabla de especificaciones coinciden con lo que dice la descripcion/titulo?
   - Ejemplo de ERROR: la tabla dice "IP65" y la descripcion dice "IP55".
   - Ejemplo de ERROR: la tabla dice "Norma IRAM 2183" y la descripcion menciona
     "IRAM 2281".
   - Si todo concuerda, estado_tecnico = "OK" y discrepancias = "Sin discrepancias".

REGLAS DE SALIDA (muy importante):
- Respondes EXCLUSIVAMENTE con un unico objeto JSON valido, sin texto extra,
  sin Markdown, sin backticks, sin prefacio.
- Esquema EXACTO:
{
  "estado_visual": "COHERENTE" | "ERROR",
  "analisis_visual": "texto breve describiendo la imagen y la coherencia con el texto",
  "estado_tecnico": "OK" | "ERROR",
  "discrepancias": "texto describiendo las discrepancias o 'Sin discrepancias'",
  "propuesta_correccion": "que deberia corregirse en la ficha web para que sea coherente; si todo esta bien, 'No requiere correccion'"
}
- NO agregues claves adicionales. NO uses otros valores en los enums.`;

/**
 * Descarga una imagen y la convierte a base64 para pasarla a Gemini como inlineData.
 * Si falla, retorna null.
 */
async function fetchImageAsInlineData(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 20 * 1024 * 1024,
      httpsAgent: undefined,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      }
    });

    let mimeType = (res.headers['content-type'] || '').split(';')[0].trim();
    if (!mimeType || !mimeType.startsWith('image/')) {
      // Inferimos por extension si hace falta.
      const ext = (imageUrl.split('?')[0].split('.').pop() || '').toLowerCase();
      const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
      mimeType = map[ext] || 'image/jpeg';
    }

    const base64 = Buffer.from(res.data).toString('base64');
    return { inlineData: { data: base64, mimeType } };
  } catch (err) {
    return null;
  }
}

/**
 * Intenta parsear JSON aunque el modelo haya incluido texto extra o markdown.
 */
function safeParseJson(text) {
  if (!text) return null;
  let clean = String(text).trim();

  // Quitar fences ```json ... ```
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(clean);
  } catch (_) {}

  // Fallback: extraer primer objeto {...}
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const slice = clean.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch (_) {}
  }
  return null;
}

function normalizeResult(raw) {
  const result = {
    estado_visual: 'ERROR',
    analisis_visual: '',
    estado_tecnico: 'ERROR',
    discrepancias: '',
    propuesta_correccion: ''
  };
  if (!raw || typeof raw !== 'object') return result;

  const vis = String(raw.estado_visual || '').toUpperCase();
  result.estado_visual = vis === 'COHERENTE' ? 'COHERENTE' : 'ERROR';

  const tec = String(raw.estado_tecnico || '').toUpperCase();
  result.estado_tecnico = tec === 'OK' ? 'OK' : 'ERROR';

  result.analisis_visual = String(raw.analisis_visual || '').trim();
  result.discrepancias = String(raw.discrepancias || '').trim();
  result.propuesta_correccion = String(raw.propuesta_correccion || '').trim();
  return result;
}

/**
 * Ejecuta la auditoria del scrape con Gemini 1.5 Flash.
 *
 * @param {{titulo:string, imagen:string|null, especificaciones:Object, url?:string, error?:string}} scrape
 * @param {{apiKey?:string, descripcionMaestra?:string}} [opts]
 * @returns {Promise<{estado_visual:string, analisis_visual:string, estado_tecnico:string, discrepancias:string, propuesta_correccion:string}>}
 */
export async function auditScrape(scrape, opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      estado_visual: 'ERROR',
      analisis_visual: 'No se pudo invocar Gemini: falta GEMINI_API_KEY.',
      estado_tecnico: 'ERROR',
      discrepancias: 'No se evaluo por falta de API key.',
      propuesta_correccion: 'Configurar GEMINI_API_KEY en el entorno.'
    };
  }

  if (!scrape || scrape.error) {
    return {
      estado_visual: 'ERROR',
      analisis_visual: `No se pudo scrapear la pagina: ${scrape?.error || 'sin datos'}`,
      estado_tecnico: 'ERROR',
      discrepancias: 'No se pudo auditar por falla del scraper.',
      propuesta_correccion: 'Revisar que la URL del producto este publicada y accesible.'
    };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  });

  const especificacionesLimpias = { ...(scrape.especificaciones || {}) };
  const descripcionLarga = especificacionesLimpias.__descripcion_larga__ || '';
  delete especificacionesLimpias.__descripcion_larga__;

  const userPayload = {
    titulo: scrape.titulo || '',
    url: scrape.url || '',
    descripcion_maestra: opts.descripcionMaestra || '',
    descripcion_publicada: descripcionLarga,
    especificaciones_publicadas: especificacionesLimpias
  };

  const parts = [
    {
      text:
        'Auditar la siguiente ficha de producto publicada en famiq.com.ar.\n' +
        'Datos extraidos de la pagina:\n' +
        JSON.stringify(userPayload, null, 2) +
        '\n\nResponde UNICAMENTE con el JSON del esquema indicado.'
    }
  ];

  const imagePart = await fetchImageAsInlineData(scrape.imagen);
  if (imagePart) {
    parts.unshift(imagePart);
  } else if (scrape.imagen) {
    parts.push({
      text:
        `No fue posible descargar la imagen publicada (${scrape.imagen}). ` +
        'Marcar estado_visual=ERROR y explicarlo en analisis_visual.'
    });
  } else {
    parts.push({
      text:
        'La pagina no expone imagen principal detectable. ' +
        'Marcar estado_visual=ERROR y explicarlo en analisis_visual.'
    });
  }

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts }]
    });
    const text = result?.response?.text?.() || '';
    const parsed = safeParseJson(text);
    if (!parsed) {
      return {
        estado_visual: 'ERROR',
        analisis_visual: 'Respuesta de Gemini no parseable como JSON.',
        estado_tecnico: 'ERROR',
        discrepancias: (text || '').slice(0, 500),
        propuesta_correccion: 'Reintentar la auditoria manualmente.'
      };
    }
    return normalizeResult(parsed);
  } catch (err) {
    return {
      estado_visual: 'ERROR',
      analisis_visual: `Error llamando a Gemini: ${err?.message || err}`,
      estado_tecnico: 'ERROR',
      discrepancias: 'No se obtuvo respuesta del modelo.',
      propuesta_correccion: 'Reintentar la auditoria manualmente.'
    };
  }
}

export default auditScrape;
