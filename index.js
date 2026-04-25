// index.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import axios from 'axios';
import ExcelJS from 'exceljs';
import pLimit from 'p-limit';
import { google } from 'googleapis';

// pdfjs-dist: libreria oficial de Mozilla para extraer texto de PDFs
// Build legacy CommonJS, estable en Node sin configuracion extra
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { launchBrowser, scrapeProduct } from './scraper.js';
import { auditScrape } from './agent.js';
import { notify } from './notifier.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SPREADSHEET_ID  = process.env.SPREADSHEET_ID  || '1QYT15W8NJ5M2UPVyvBy-QqfnOA4fEbTbbZfy7qrNLrY';
const INPUT_SHEET     = process.env.INPUT_SHEET     || 'Hoja2';
const OUTPUT_XLSX     = process.env.OUTPUT_XLSX     || 'Reporte_Auditoria_IA.xlsx';
const CHECKPOINT_FILE = process.env.CHECKPOINT_FILE || 'checkpoint.json';
const CONCURRENCY     = parseInt(process.env.CONCURRENCY || '8', 10);
const RECIPIENT       = process.env.REPORT_RECIPIENT || 'jortiz@famiq.com.ar';

const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly'
];
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// -------------------- Cache de PDFs --------------------
// In-memory buffer cache: evita descargar el mismo PDF dos veces en la misma ejecución
const pdfCache = new Map(); // url -> Buffer

// Persistent hash cache: evita re-hashear PDFs ya procesados en ejecuciones anteriores
// Subir CACHE_SCHEMA invalida el cache existente (ej: al cambiar extractVersion)
const PDF_HASH_CACHE_FILE = 'pdf_hash_cache.json';
const CACHE_SCHEMA = 2;
let pdfHashCache = {};

function loadPdfHashCache() {
  try {
    if (fs.existsSync(PDF_HASH_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PDF_HASH_CACHE_FILE, 'utf8'));
      if (data?._schema === CACHE_SCHEMA && data?.entries) {
        pdfHashCache = data.entries;
        console.log(`[pdfcache] ${Object.keys(pdfHashCache).length} entradas cargadas (schema ${CACHE_SCHEMA})`);
        return;
      }
      console.log(`[pdfcache] schema obsoleto (era ${data?._schema||'none'}, ahora ${CACHE_SCHEMA}) — regenerando`);
    }
  } catch (err) {
    console.warn(`[pdfcache] No se pudo leer: ${err?.message}`);
  }
  pdfHashCache = {};
}

function savePdfHashCache() {
  try {
    fs.writeFileSync(
      PDF_HASH_CACHE_FILE,
      JSON.stringify({ _schema: CACHE_SCHEMA, entries: pdfHashCache }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.warn(`[pdfcache] No se pudo escribir: ${err?.message}`);
  }
}

function col(row, oneBasedIndex) {
  const v = row[oneBasedIndex - 1];
  return v == null ? '' : String(v).trim();
}

export function normalizeDriveUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';
  const m = s.match(/\/file\/d\/([^/]+)/) || s.match(/[?&]id=([^&]+)/);
  if (m && m[1]) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return s;
}

// Extrae el fileId de una URL de Google Drive
function driveFileId(url) {
  const s = String(url || '').trim();
  const m = s.match(/\/file\/d\/([^/?#]+)/) || s.match(/[?&]id=([^&]+)/);
  return m ? m[1] : null;
}

// Descarga Drive de forma anónima (funciona si el archivo es "Cualquiera con el enlace")
// Agrega &confirm=t para saltear la pantalla de confirmación de archivos grandes
async function downloadDriveAnonymous(fileId, timeout = 60000) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout,
    maxRedirects: 10,
    httpsAgent: insecureAgent,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const buf = Buffer.from(res.data);
  if (buf.length === 0) throw new Error('respuesta vacía');
  // Si Drive devolvió HTML (login wall, confirmación) en vez del PDF, rechazar
  const header = buf.slice(0, 5).toString('ascii');
  if (!header.startsWith('%PDF')) {
    const preview = buf.slice(0, 120).toString('utf-8').replace(/\s+/g, ' ');
    throw new Error(`no es PDF — posiblemente no es público. Preview: ${preview.slice(0, 80)}`);
  }
  return buf;
}

// Descarga Drive autenticada con la cuenta de servicio (para archivos privados compartidos con el SA)
async function downloadDriveAuthenticated(fileId) {
  const auth  = new google.auth.GoogleAuth({ scopes: SHEETS_SCOPES });
  const drive = google.drive({ version: 'v3', auth });
  const res   = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true, includeItemsFromAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  const buf = Buffer.from(res.data);
  if (buf.length === 0) throw new Error(`respuesta vacía — verificar que el SA tenga acceso al archivo`);
  return buf;
}

async function downloadBufferWithCache(url, { timeout = 60000, retries = 3 } = {}) {
  const cacheKey = url.trim();
  if (pdfCache.has(cacheKey)) {
    return pdfCache.get(cacheKey);
  }

  // Archivos de Google Drive: intentar anónimo primero, luego autenticado
  const fileId = driveFileId(url);
  if (fileId) {
    try {
      const buf = await downloadDriveAnonymous(fileId, timeout);
      console.log(`[pdf] Drive anónimo OK (${buf.length} bytes) fileId=${fileId}`);
      pdfCache.set(cacheKey, buf);
      return buf;
    } catch (anonErr) {
      console.warn(`[pdf] Drive anónimo falló: ${anonErr.message} — usando API autenticada...`);
      const buf = await downloadDriveAuthenticated(fileId);
      console.log(`[pdf] Drive autenticado OK (${buf.length} bytes) fileId=${fileId}`);
      pdfCache.set(cacheKey, buf);
      return buf;
    }
  }

  // Para URLs externas (PDF publicado en web de Famiq), usar axios normal
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout,
        maxRedirects: 10,
        httpsAgent: insecureAgent,
        validateStatus: (s) => s >= 200 && s < 400,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const buf = Buffer.from(res.data);
      pdfCache.set(cacheKey, buf);
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = 10000 * attempt;
        console.warn(`[pdf] intento ${attempt}/${retries} fallido para ${url.slice(0, 80)}, reintentando en ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function extractVersion(text) {
  // Detecta: V4.2019, V4-2019, V2019, Versión 4.2019, Rev. 1.2, Edición 3
  const patterns = [
    /\bV\s*\d+\s*[.\-\/]\s*\d+(?:\s*[.\-\/]\s*\d+)*/i,  // V4.2019 (con separador, tolera espacios)
    /\bV\s*\d{3,}\b/i,                                   // V2019 (sin separador, ≥3 dígitos)
    /[Vv]ersi[oó]n\s*:?\s*\d[\d\s\-.\/]*\d?/,
    /[Rr]ev(?:\.|\s|isi[oó]n)\s*:?\s*\d[\d\s\-.\/]*\d?/,
    /[Ee]dici[oó]n\s*:?\s*\d[\d\s\-.\/]*\d?/,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = text.match(patterns[i]);
    if (m) {
      // Patrones V-compactos: quitar todo espacio (V 4 . 2019 → V4.2019)
      if (i < 2) return m[0].replace(/\s+/g, '');
      // Patrones con palabra (Versión/Rev/Edición): colapsar espacios
      return m[0].replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

// Extrae texto de un PDF con pdfjs-dist, normaliza y devuelve hash SHA-256 + versión
async function extractPdfContent(buf) {
  const header = buf.slice(0, 5).toString('ascii');
  if (!header.startsWith('%PDF')) {
    const preview = buf.slice(0, 120).toString('utf-8').replace(/\s+/g, ' ').trim();
    console.warn('[pdf] El buffer descargado no es un PDF. Primeros bytes:', preview);
    return { hash: sha256(buf), version: '' };
  }

  try {
    const uint8 = new Uint8Array(buf);
    const loadingTask = getDocument({
      data: uint8,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0
    });
    const doc = await loadingTask.promise;
    let fullText = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      fullText += tc.items.map(it => it.str || '').join(' ') + ' ';
    }
    await doc.destroy();

    const version = extractVersion(fullText);
    console.log(`[pdf] version="${version||'(no detectada)'}" chars=${fullText.length}`);

    const normalized = fullText
      .toLowerCase()
      .replace(/,/g, '.')
      .replace(/[\s\r\n]+/g, '')
      .replace(/[^ -~]/g, '');

    if (normalized.length < 20) {
      console.warn('[pdf] Texto extraido muy corto, usando hash de bytes');
      return { hash: sha256(buf), version };
    }
    return { hash: crypto.createHash('sha256').update(normalized).digest('hex'), version };
  } catch (err) {
    console.warn('[pdf] No se pudo extraer texto, usando hash de bytes:', err?.message?.slice(0,80));
    return { hash: sha256(buf), version: '' };
  }
}

async function getHashForUrl(url) {
  if (pdfHashCache[url]) {
    console.log(`[pdfcache] hit: ${url.slice(0, 70)}`);
    return pdfHashCache[url];
  }
  const buf = await downloadBufferWithCache(url);
  const result = await extractPdfContent(buf);
  pdfHashCache[url] = result;
  savePdfHashCache();
  return result;
}

async function checkPdfIntegrity(urlFtBase, nombreArchivo, urlDriveRaw) {
  const result = { integridad: 'ERROR', hashWeb: '', hashMaestro: '', detalle: '', urlFtDrive: '', urlFtWeb: '', versionPdf: '' };

  let urlWeb = '';
  if (urlFtBase) {
    const isCompleteUrl = /\.\w{2,5}$/i.test(urlFtBase.split('?')[0].split('#')[0]);
    if (isCompleteUrl || !nombreArchivo) {
      urlWeb = urlFtBase;
    } else {
      const base = urlFtBase.endsWith('/') ? urlFtBase : urlFtBase + '/';
      urlWeb = base + nombreArchivo;
    }
  }

  result.urlFtDrive = urlDriveRaw || '';
  result.urlFtWeb   = urlWeb;
  const urlDrive = normalizeDriveUrl(urlDriveRaw);

  const [webRes, driveRes] = await Promise.allSettled([
    urlWeb   ? getHashForUrl(urlWeb)   : Promise.reject(new Error('Sin URL FT web')),
    urlDrive ? getHashForUrl(urlDrive) : Promise.reject(new Error('Sin Link FT Drive'))
  ]);

  const errs = [];
  if (webRes.status === 'fulfilled') {
    result.hashWeb    = webRes.value.hash;
    result.versionPdf = webRes.value.version;
  } else {
    errs.push(`PDF web: ${webRes.reason?.message || webRes.reason}`);
  }
  if (driveRes.status === 'fulfilled') {
    result.hashMaestro = driveRes.value.hash;
  } else {
    errs.push(`PDF Drive: ${driveRes.reason?.message || driveRes.reason}`);
  }

  if (result.hashWeb && result.hashMaestro) {
    result.integridad = result.hashWeb === result.hashMaestro ? 'OK' : 'DESACTUALIZADO';
    result.detalle    = result.integridad === 'OK'
      ? 'Hash SHA-256 coincide.'
      : 'El PDF publicado NO coincide con el maestro de Drive.';
    console.log(`[pdf] ${result.integridad} web=${result.hashWeb.slice(0,8)}… drive=${result.hashMaestro.slice(0,8)}…`);
  } else {
    result.integridad = 'ERROR';
    result.detalle    = errs.join(' | ') || 'No se pudieron descargar los PDFs.';
    console.warn(`[pdf] ERROR integridad: ${result.detalle}`);
    console.warn(`[pdf]   urlWeb=${urlWeb.slice(0,80)}`);
    console.warn(`[pdf]   urlDrive=${urlDrive.slice(0,80)}`);
  }
  return result;
}

// -------------------- checkpoint --------------------

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const json = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      if (json?.results) return json;
    }
  } catch (err) {
    console.warn(`[checkpoint] No se pudo leer: ${err?.message || err}`);
  }
  return { results: {} };
}

function saveCheckpoint(state) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[checkpoint] No se pudo escribir: ${err?.message || err}`);
  }
}

// -------------------- Google Sheets --------------------

async function readSheetRows(spreadsheetId, sheetName) {
  const auth   = new google.auth.GoogleAuth({ scopes: SHEETS_SCOPES });
  const sheets = google.sheets({ version: 'v4', auth });
  const resp   = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });

  const rawRows = resp.data.values || [];
  if (rawRows.length === 0) throw new Error(`La hoja "${sheetName}" esta vacia.`);

  const rows = [];
  rawRows.slice(1).forEach((r, i) => {
    const rowNumber      = i + 2;
    const id             = col(r, 1);   // col A: ID
    const sku            = col(r, 2);   // col B: SKU
    // col C: Descripción interna (no usada como texto maestro)
    // col D: Linea
    // col E: Subfamilia
    const urlProducto    = col(r, 6);   // col F: URL producto
    // col G: sub-Familia
    // col H: ID producto
    const urlFtBase      = col(r, 9);   // col I: URL FT (base, sin nombre de archivo)
    const nombreArchivo  = col(r, 10);  // col J: Nombre archivo PDF
    const linkFtDrive    = col(r, 11);  // col K: Link FT Drive
    const textoComercial = col(r, 12);  // col L: Texto Comercial (FUENTE DE VERDAD)
    const urlImagen      = col(r, 13);  // col M: URL imagen directa (chica)

    if (!id && !sku && !urlProducto) return;
    rows.push({ rowNumber, id, sku, urlProducto, urlFtBase, nombreArchivo, linkFtDrive, textoComercial, urlImagen });
  });
  return rows;
}

// -------------------- reporte Excel --------------------

async function writeReport(filePath, results) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Agente Auditor de Calidad Web';
  wb.created = new Date();
  const ws   = wb.addWorksheet('Auditoria');

  ws.columns = [
    { header: 'SKU',                        key: 'sku',             width: 18 },
    { header: 'Texto Comercial',             key: 'textoComercial',  width: 55 },
    { header: 'URL Famiq',                   key: 'urlFamiq',        width: 50 },
    { header: 'Integridad PDF',              key: 'integridad',      width: 18 },
    { header: 'Hash Web',                    key: 'hashWeb',         width: 66 },
    { header: 'Hash Maestro (Drive)',         key: 'hashMaestro',     width: 66 },
    { header: 'Estado Visual',               key: 'estadoVisual',    width: 18 },
    { header: 'Analisis Visual',             key: 'analisisVisual',  width: 55 },
    { header: 'Estado Tecnico',              key: 'estadoTecnico',   width: 16 },
    { header: 'Validaciones',                key: 'validaciones',    width: 65 },
    { header: 'Discrepancias',               key: 'discrepancias',   width: 65 },
    { header: 'Recomendaciones',             key: 'recomendaciones', width: 55 },
    { header: 'Propuesta de Correccion',     key: 'propuesta',       width: 55 },
    { header: 'Link FT Drive (maestro)',     key: 'urlFtDrive',      width: 80 },
    { header: 'URL Imagen Auditada',         key: 'urlImagen',       width: 80 },
    { header: 'URL FT Web (PDF publicado)',  key: 'urlFtWeb',        width: 80 },
    { header: 'Version PDF',                 key: 'versionPdf',      width: 20 },
    { header: 'Descripcion Web',             key: 'descripcionWeb',  width: 70 },
  ];

  const header = ws.getRow(1);
  header.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  header.height    = 30;

  const colorFor = (val) => {
    if (!val) return null;
    if (['OK', 'COHERENTE'].includes(val)) return 'FFC6EFCE';
    if (val === 'DESACTUALIZADO')          return 'FFFFEB9C';
    if (val === 'ERROR_DESCARGA')          return 'FFFFD966'; // amarillo — pendiente reintento
    if (val === 'SIN_IMAGEN')              return 'FFDCE6F1';
    return 'FFFFC7CE';
  };

  results.forEach((r) => {
    const row = ws.addRow({
      sku: r.sku, textoComercial: r.textoComercial, urlFamiq: r.urlProducto,
      integridad: r.integridad, hashWeb: r.hashWeb, hashMaestro: r.hashMaestro,
      estadoVisual: r.estadoVisual, analisisVisual: r.analisisVisual,
      estadoTecnico: r.estadoTecnico, validaciones: r.validaciones,
      discrepancias: r.discrepancias, recomendaciones: r.recomendaciones,
      propuesta: r.propuesta,
      urlFtDrive: r.urlFtDrive || '', urlImagen: r.urlImagen || '',
      urlFtWeb: r.urlFtWeb || '', versionPdf: r.versionPdf || '',
      descripcionWeb: r.descripcionWeb || ''
    });
    row.alignment = { vertical: 'top', wrapText: true };

    const paint = (key, argb) => {
      if (!argb) return;
      row.getCell(key).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    };
    paint('integridad',   colorFor(r.integridad));
    paint('estadoVisual', colorFor(r.estadoVisual));
    paint('estadoTecnico',colorFor(r.estadoTecnico));

    const linkCell = (key, url) => {
      if (!url) return;
      const c = row.getCell(key);
      c.value = { text: url, hyperlink: url };
      c.font  = { color: { argb: 'FF0563C1' }, underline: true };
    };
    linkCell('urlFamiq',  r.urlProducto);
    linkCell('urlFtDrive', r.urlFtDrive);
    linkCell('urlImagen',  r.urlImagen);
    linkCell('urlFtWeb',   r.urlFtWeb);
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  await wb.xlsx.writeFile(filePath);
}

// -------------------- pipeline por fila --------------------

async function processRow(row, browser) {
  const base = {
    sku: row.sku, textoComercial: row.textoComercial, urlProducto: row.urlProducto,
    integridad: 'ERROR', hashWeb: '', hashMaestro: '',
    estadoVisual: 'ERROR', analisisVisual: '',
    estadoTecnico: 'ERROR', validaciones: '', discrepancias: '',
    recomendaciones: '', propuesta: '',
    urlImagen: row.urlImagen || '', urlFtWeb: '', versionPdf: '',
    descripcionWeb: ''
  };

  // 1) Integridad PDF (con cache — si el mismo PDF aparece en varias filas, se descarga una sola vez)
  try {
    const pdf = await checkPdfIntegrity(row.urlFtBase, row.nombreArchivo, row.linkFtDrive);
    base.integridad  = pdf.integridad;
    base.hashWeb     = pdf.hashWeb;
    base.hashMaestro = pdf.hashMaestro;
    base.urlFtDrive  = pdf.urlFtDrive || row.linkFtDrive || '';
    base.urlFtWeb    = pdf.urlFtWeb   || '';
    base.versionPdf  = pdf.versionPdf || '';
    if (pdf.detalle && pdf.integridad !== 'OK') {
      base.discrepancias = `[PDF] ${pdf.detalle}`;
    }
  } catch (err) {
    base.integridad    = 'ERROR';
    base.discrepancias = `[PDF] ${err?.message || err}`;
  }

  // 2) Scrape del producto
  let scrape = row.urlProducto
    ? await scrapeProduct(row.urlProducto, browser, row.urlImagen)
    : { error: 'Fila sin URL de producto.' };

  // Si falló pero tenemos imagen en col M, preservarla para el agent
  if (scrape.error && row.urlImagen) {
    scrape.imagen = row.urlImagen;
  }
  base.urlImagen = scrape.imagen || row.urlImagen || '';

  // Capturar descripción antes de que auditScrape la elimine de su copia local
  base.descripcionWeb = scrape.especificaciones?.['__descripcion_larga__']?.slice(0, 600) || '';

  // 3) Auditoria IA: compara texto comercial (col 12) vs specs web + valida imagen
  const audit = await auditScrape(scrape, { descripcionMaestra: row.textoComercial });
  base.estadoVisual    = audit.estado_visual;
  base.analisisVisual  = audit.analisis_visual;
  base.estadoTecnico   = audit.estado_tecnico;
  base.validaciones    = audit.validaciones    || '';
  base.recomendaciones = audit.recomendaciones || '';

  const agentDisc = audit.discrepancias || '';
  if (base.discrepancias && agentDisc && agentDisc !== 'Sin discrepancias') {
    base.discrepancias = `${base.discrepancias} | [IA] ${agentDisc}`;
  } else if (agentDisc && agentDisc !== 'Sin discrepancias') {
    base.discrepancias = agentDisc;
  }
  base.propuesta = audit.propuesta_correccion || '';
  return base;
}

// -------------------- main --------------------

async function main() {
  console.log('=== Agente Auditor de Calidad Web ===');
  console.log(`Sheet: ${SPREADSHEET_ID} | Hoja: ${INPUT_SHEET}`);
  console.log(`Salida: ${OUTPUT_XLSX} | Concurrencia: ${CONCURRENCY}`);
  loadPdfHashCache();

  if (!process.env.ANTHROPIC_API_KEY) console.warn('[warn] ANTHROPIC_API_KEY no seteada.');

  const rows = await readSheetRows(SPREADSHEET_ID, INPUT_SHEET);
  console.log(`Filas a auditar: ${rows.length}`);

  const checkpoint = loadCheckpoint();
  const results    = checkpoint.results || {};
  const browser    = await launchBrowser();
  const limit      = pLimit(CONCURRENCY);
  let done = 0;

  const tasks = rows.map((row) =>
    limit(async () => {
      const key = String(row.rowNumber);
      if (results[key]) {
        done++;
        console.log(`[skip ${done}/${rows.length}] ${row.sku || row.id} (checkpoint)`);
        return;
      }
      try {
        const res    = await processRow(row, browser);
        results[key] = res;
        done++;
        console.log(`[ok ${done}/${rows.length}] ${row.sku} pdf=${res.integridad} visual=${res.estadoVisual} tec=${res.estadoTecnico}`);
      } catch (err) {
        results[key] = {
          sku: row.sku, textoComercial: row.textoComercial, urlProducto: row.urlProducto,
          integridad: 'ERROR', hashWeb: '', hashMaestro: '',
          estadoVisual: 'ERROR', analisisVisual: `Fallo: ${err?.message || err}`,
          estadoTecnico: 'ERROR', validaciones: '', discrepancias: '',
          recomendaciones: '', propuesta: '',
          urlImagen: row.urlImagen || '', urlFtWeb: '', versionPdf: '',
          descripcionWeb: ''
        };
        done++;
        console.error(`[err ${done}/${rows.length}] ${row.sku}: ${err?.message || err}`);
      } finally {
        saveCheckpoint({ results });
      }
    })
  );

  await Promise.all(tasks);

  // ---- Reintentos para filas con error de descarga de imagen ----
  const retryKeys = Object.keys(results).filter(k => results[k]?.estadoVisual === 'ERROR_DESCARGA');
  if (retryKeys.length > 0) {
    console.log(`\n[retry] ${retryKeys.length} filas con ERROR_DESCARGA — reintentando en 30s...`);
    await new Promise(r => setTimeout(r, 30000));
    for (const key of retryKeys) {
      const row = rows.find(r => String(r.rowNumber) === key);
      if (!row) continue;
      try {
        console.log(`[retry] ${row.sku}...`);
        // Borrar del checkpoint para forzar reproceso
        delete results[key];
        const res = await processRow(row, browser);
        results[key] = res;
        console.log(`[retry ok] ${row.sku} visual=${res.estadoVisual} tec=${res.estadoTecnico}`);
      } catch (err) {
        results[key] = results[key] || {};
        results[key].analisisVisual = `Reintento fallido: ${err?.message || err}`;
        console.error(`[retry err] ${row.sku}: ${err?.message || err}`);
      }
      saveCheckpoint({ results });
    }
  }

  const ordered = rows.map((r) => results[String(r.rowNumber)]).filter(Boolean);
  const outPath = path.resolve(process.cwd(), OUTPUT_XLSX);
  await writeReport(outPath, ordered);
  console.log(`Reporte generado: ${outPath}`);

  try { await notify(outPath, { to: RECIPIENT }); } catch (err) {
    console.error(`[notifier] ${err?.message || err}`);
  }

  try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
  console.log('=== Fin de la auditoria ===');
}

main().catch((err) => { console.error('Fallo general:', err); process.exitCode = 1; });


