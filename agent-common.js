// agent-common.js — helpers y prompts compartidos entre el modo sync y batch
import axios from 'axios';
import https from 'node:https';
import sharp from 'sharp';

export const insecureAgent = new https.Agent({ rejectUnauthorized: false });

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_BETA    = 'prompt-caching-2024-07-31,message-batches-2024-09-24';
export const MODEL             = 'claude-haiku-4-5-20251001';
export const MAX_TOKENS        = 1500;

// ── Prompts ──────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT_FULL = `Inspector de Oficina Tecnica de Famiq. Auditas fichas de producto web.

Inputs:
- texto_comercial: nombre oficial interno (FUENTE DE VERDAD)
- titulo_web: titulo publicado en famiq.com.ar
- descripcion_web: descripcion generica del producto en la pagina
- specs: tabla de especificaciones tecnicas
- imagen adjunta: foto del producto tomada de la columna M del inventario

REGLA CRITICA PARA IMAGEN:
- Si recibes una imagen adjunta en este mensaje: DEBES evaluarla. Usa COHERENTE si muestra el producto correcto segun texto_comercial, o ERROR si muestra otro producto o es incorrecta. NUNCA uses SIN_IMAGEN si recibes una imagen.
- Solo usa SIN_IMAGEN si el mensaje NO contiene imagen adjunta.

Validar:
A) VISUAL: la imagen adjunta corresponde al texto_comercial? (COHERENTE/ERROR/SIN_IMAGEN segun regla)
B) TECNICO texto_comercial vs specs: material (304/304L/316/316L), diametro (mm/DN/pulg), norma (DAN/DIN/SMS/SCH), conexion. Campo por campo.
C) TEXTO WEB vs specs: titulo_web coincide con specs?
D) DESCRIPCION: descripcion_web es coherente con la FAMILIA del producto en texto_comercial? No se exige detalle tecnico — solo que hable del tipo correcto (valvula, tuerca, codo, bomba, etc.). Si descripcion_web esta vacia o ausente: SIN_DESCRIPCION.

REGLAS CRITICAS DE VALIDACION TECNICA:
1. SOLO compara campos que existan en AMBOS lados (texto_comercial Y specs). Si un campo aparece en solo uno, OMITILO completamente — no lo incluyas en validaciones ni lo marques ERR.
2. estado_tecnico = "ERROR" SOLO si hay contradiccion REAL entre valores presentes en ambos lados (ej: material 304L vs 316L). Specs incompletas NO son error tecnico — van en recomendaciones.

Errores criticos: material wrong (en ambos lados), diametro wrong (en ambos lados), norma wrong (en ambos lados), imagen de otro producto, specs de otro SKU, descripcion de familia incorrecta.
Recomendaciones: titulo mal redactado, specs incompletas, campos faltantes en specs.

Responde SOLO JSON valido. Sin bloques markdown, sin ```json, sin texto fuera del JSON:
{"estado_visual":"COHERENTE"|"ERROR"|"SIN_IMAGEN","analisis_visual":"texto","estado_tecnico":"OK"|"ERROR","validaciones":"campo:maestro=X tabla=Y OK/ERR | ...","discrepancias":"lista o Sin discrepancias","recomendaciones":"lista o Sin recomendaciones","propuesta_correccion":"texto o No requiere correccion","estado_descripcion":"COHERENTE"|"INCOHERENTE"|"SIN_DESCRIPCION","analisis_descripcion":"texto breve"}`;

export const SYSTEM_PROMPT_TECHNICAL = `Inspector de Oficina Tecnica de Famiq. Auditas fichas de producto web.

Inputs:
- texto_comercial: nombre oficial interno (FUENTE DE VERDAD)
- titulo_web: titulo publicado en famiq.com.ar
- descripcion_web: descripcion generica del producto en la pagina
- specs: tabla de especificaciones tecnicas

Validar (sin imagen — evaluacion visual ya realizada):
B) TECNICO texto_comercial vs specs: material (304/304L/316/316L), diametro (mm/DN/pulg), norma (DAN/DIN/SMS/SCH), conexion. Campo por campo.
C) TEXTO WEB vs specs: titulo_web coincide con specs?
D) DESCRIPCION: descripcion_web es coherente con la FAMILIA del producto en texto_comercial? No se exige detalle tecnico — solo que hable del tipo correcto (valvula, tuerca, codo, bomba, etc.). Si descripcion_web esta vacia o ausente: SIN_DESCRIPCION.

REGLAS CRITICAS DE VALIDACION TECNICA:
1. SOLO compara campos que existan en AMBOS lados (texto_comercial Y specs). Si un campo aparece en solo uno, OMITILO completamente — no lo incluyas en validaciones ni lo marques ERR.
2. estado_tecnico = "ERROR" SOLO si hay contradiccion REAL entre valores presentes en ambos lados (ej: material 304L vs 316L). Specs incompletas NO son error tecnico — van en recomendaciones.

Errores criticos: material wrong (en ambos lados), diametro wrong (en ambos lados), norma wrong (en ambos lados), specs de otro SKU, descripcion de familia incorrecta.
Recomendaciones: titulo mal redactado, specs incompletas, campos faltantes en specs.

Responde SOLO JSON valido. Sin bloques markdown, sin ```json, sin texto fuera del JSON:
{"estado_tecnico":"OK"|"ERROR","validaciones":"campo:maestro=X tabla=Y OK/ERR | ...","discrepancias":"lista o Sin discrepancias","recomendaciones":"lista o Sin recomendaciones","propuesta_correccion":"texto o No requiere correccion","estado_descripcion":"COHERENTE"|"INCOHERENTE"|"SIN_DESCRIPCION","analisis_descripcion":"texto breve"}`;

export const SYSTEM_PROMPT_VERIFY = `Inspector visual senior de Famiq. Una primera revisión IA sugirió que la imagen NO corresponde al producto declarado. Tu tarea es verificar críticamente ese diagnóstico antes de confirmarlo como ERROR.

Reglas para la verificación:
1. La calidad de la foto puede ser baja (thumbnail). No descartes el producto sólo porque cuesta verlo.
2. Componentes accesorios (actuadores, conexiones, soportes, manómetros) suelen tapar partes distintivas del producto principal. Eso no implica que el producto sea otro.
3. Tipos similares pueden verse parecidos a baja resolución (mariposa vs bola con actuador, codo vs T desde un ángulo, conexion SMS vs DIN).
4. Solo CONFIRMA ERROR si ves CLARAMENTE caracteristicas que CONTRADICEN el producto declarado (ej: sin duda es una bomba en vez de una valvula, o claramente es un caño recto cuando deberia ser un codo).
5. Si tenes cualquier duda razonable o la foto no permite descartar el producto declarado: respondé COHERENTE.

Responde SOLO JSON valido:
{"estado_visual":"COHERENTE"|"ERROR","analisis_visual":"justificacion detallada de por que confirmas o cambias el diagnostico","confianza":"alta"|"media"|"baja"}`;

// ── Imagen: descarga + resize ────────────────────────────────────────────────

export async function resizeImage(buf) {
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

export async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) return null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 40000,
        maxContentLength: 10 * 1024 * 1024,
        validateStatus: (s) => s >= 200 && s < 400,
        httpsAgent: insecureAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.famiq.com.ar/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });
      const rawBuf = Buffer.from(res.data);
      // Validar magic bytes — rechazar si no es imagen (ej: página HTML de error con HTTP 200)
      const sig = rawBuf.slice(0, 4);
      const isJpeg = sig[0] === 0xFF && sig[1] === 0xD8;
      const isPng  = sig[0] === 0x89 && sig[1] === 0x50;
      const isGif  = sig[0] === 0x47 && sig[1] === 0x49;
      const isWebp = sig[0] === 0x52 && sig[1] === 0x49;
      if (!isJpeg && !isPng && !isGif && !isWebp) {
        const preview = rawBuf.slice(0, 60).toString('ascii').replace(/[^\x20-\x7E]/g, '?');
        throw new Error(`Respuesta no es imagen (magic: ${sig.toString('hex')}). Preview: ${preview}`);
      }
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

// ── Parseo y normalización de la respuesta de Claude ─────────────────────────

export function safeParseJson(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'').trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) try { return JSON.parse(s.slice(a, b+1)); } catch {}
  return null;
}

export function normalize(raw) {
  if (!raw || typeof raw !== 'object') return {
    estado_visual:'SIN_IMAGEN', analisis_visual:'Sin imagen.', estado_tecnico:'ERROR',
    validaciones:'', discrepancias:'', recomendaciones:'', propuesta_correccion:'',
    estado_descripcion:'SIN_DESCRIPCION', analisis_descripcion:''
  };
  const v = String(raw.estado_visual||'').toUpperCase();
  const d = String(raw.estado_descripcion||'').toUpperCase();
  return {
    estado_visual:        v==='COHERENTE'?'COHERENTE': v==='ERROR'?'ERROR': v==='ERROR_DESCARGA'?'ERROR_DESCARGA':'SIN_IMAGEN',
    analisis_visual:      String(raw.analisis_visual      ||'').trim(),
    estado_tecnico:       String(raw.estado_tecnico       ||'').toUpperCase()==='OK'?'OK':'ERROR',
    validaciones:         String(raw.validaciones         ||'').trim(),
    discrepancias:        String(raw.discrepancias        ||'').trim(),
    recomendaciones:      String(raw.recomendaciones      ||'').trim(),
    propuesta_correccion: String(raw.propuesta_correccion ||'').trim(),
    estado_descripcion:   d==='COHERENTE'?'COHERENTE': d==='INCOHERENTE'?'INCOHERENTE':'SIN_DESCRIPCION',
    analisis_descripcion: String(raw.analisis_descripcion ||'').trim()
  };
}

// ── Construcción del payload de auditoría (compartido entre sync y batch) ────

// Devuelve { userText, imageUrl, hasImage, errResult? } — no toca la API
export function buildAuditPayload(scrape, opts = {}) {
  if (scrape?.error && !scrape?.imagen) {
    return {
      _earlyError: {
        estado_visual:'SIN_IMAGEN',
        analisis_visual:`No se pudo scrapear: ${scrape?.error||'sin datos'}`,
        estado_tecnico:'ERROR',
        validaciones:'',
        discrepancias:'Falla del scraper.',
        recomendaciones:'',
        propuesta_correccion:'',
        estado_descripcion:'SIN_DESCRIPCION',
        analisis_descripcion:''
      }
    };
  }
  const specs = { ...(scrape.especificaciones||{}) };
  const desc  = specs.__descripcion_larga__ || '';
  delete specs.__descripcion_larga__;
  delete specs.__sku_web__;

  const userText = 'Auditar producto famiq.com.ar:\n' +
    JSON.stringify({
      texto_comercial:  opts.descripcionMaestra || '',
      titulo_web:       scrape.titulo || '',
      descripcion_web:  desc.slice(0, 350),
      specs
    }, null, 1) +
    '\nResponde SOLO el JSON indicado.';

  return { userText, imageUrl: scrape.imagen || null };
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
