// agent.js
import axios from 'axios';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent';

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
   - Si dice "caja estanca IP65 de 4 modulos" pero la imagen es un interruptor, es un ERROR.
   - Si la imagen no se puede analizar por algun motivo, devolve estado "ERROR" y explicalo en analisis_visual.

B) CONSISTENCIA NUMERICA / TECNICA:
   - Las medidas, calibres, normas, grados IP y materiales que aparecen en la
     tabla de especificaciones coinciden con lo que dice la descripcion/titulo?
   - Si todo concuerda, estado_tecnico = "OK" y discrepancias = "Sin discrepancias".

REGLAS DE SALIDA:
- Respondes EXCLUSIVAMENTE con un unico objeto JSON valido, sin texto extra, sin Markdown.
- Esquema EXACTO:
{
  "estado_visual": "COHERENTE" | "ERROR",
  "analisis_visual": "texto breve",
  "estado_tecnico": "OK" | "ERROR",
  "discrepancias": "texto o 'Sin discrepancias'",
  "propuesta_correccion": "que corregir o 'No requiere correccion'"
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
    return { data: Buffer.from(res.data).toString('base64'), mimeType };
  } catch {
    return null;
  }
}

function safeParseJson(text) {
  if (!text) return null;
  let clean = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); } catch {}
  const first = clean.indexOf('{'), last = clean.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(clean.slice(first, last + 1)); } catch {}
  }
  return null;
}

function normalizeResult(raw) {
  const result = { estado_visual: 'ERROR', analisis_visual: '', estado_tecnico: 'ERROR', discrepancias: '', propuesta_correccion: '' };
  if (!raw || typeof raw !== 'object') return result;
  result.estado_visual = String(raw.estado_visual || '').toUpperCase() === 'COHERENTE' ? 'COHERENTE' : 'ERROR';
  result.estado_tecnico = String(raw.estado_tecnico || '').toUpperCase() === 'OK' ? 'OK' : 'ERROR';
  result.analisis_visual = String(raw.analisis_visual || '').trim();
  result.discrepancias = String(raw.discrepancias || '').trim();
  result.propuesta_correccion = String(raw.propuesta_correccion || '').trim();
  return result;
}

export async function auditScrape(scrape, opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return { estado_visual: 'ERROR', analisis_visual: 'Falta GEMINI_API_KEY.', estado_tecnico: 'ERROR', discrepancias: '', propuesta_correccion: '' };

  if (!scrape || scrape.error) return {
    estado_visual: 'ERROR',
    analisis_visual: `No se pudo scrapear: ${scrape?.error || 'sin datos'}`,
    estado_tecnico: 'ERROR',
    discrepancias: 'Falla del scraper.',
    propuesta_correccion: 'Revisar URL del producto.'
  };

  const especificacionesLimpias = { ...(scrape.especificaciones || {}) };
  const descripcionLarga = especificacionesLimpias.__descripcion_larga__ || '';
  delete especificacionesLimpias.__descripcion_larga__;

  const userText = `Auditar la siguiente ficha de producto publicada en famiq.com.ar.\n` +
    JSON.stringify({
      titulo: scrape.titulo || '',
      url: scrape.url || '',
      descripcion_maestra: opts.descripcionMaestra || '',
      descripcion_publicada: descripcionLarga,
      especificaciones_publicadas: especificacionesLimpias
    }, null,
