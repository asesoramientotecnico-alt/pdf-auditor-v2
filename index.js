// index.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import axios from 'axios';
import ExcelJS from 'exceljs';
import pLimit from 'p-limit';
import { google } from 'googleapis';

import pdfParse from 'pdf-parse/node';
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

const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// -------------------- Cache de PDFs --------------------
// Evita descargar el mismo PDF dos veces cuando varias filas apuntan al mismo archivo
const pdfCache = new Map(); // url -> { hash, buf }

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

async function downloadBufferWithCache(url, { timeout = 60000, retries = 3 } = {}) {
  const cacheKey = url.trim();
  if (pdfCache.has(cacheKey)) {
    return pdfCache.get(cacheKey);
  }

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

// Extrae texto de un PDF, lo normaliza y devuelve su hash SHA-256
// Esto evita falsos positivos por diferencias en metadatos del archivo
async function contentHash(buf) {
  try {
    const data = await pdfParse(buf, { max: 0 });
    const text = data.text || '';
    const normalized = text
      .toLowerCase()
      .replace(/,/g, '.')
      .replace(/[\s\r\n]+/g, '')
      .replace(/[^ -~]/g, '');
    if (normalized.length < 20) {
      console.warn('[pdf] Texto extraido muy corto, usando hash de bytes');
      return sha256(buf);
    }
    return crypto.createHash('sha256').update(normalized).digest('hex');
  } catch (err) {
    console.warn('[pdf] No se pudo extraer texto, usando hash de bytes:', err?.message?.slice(0,60));
    return sha256(buf);
  }
}

async function checkPdfIntegrity(urlFtBase, nombreArchivo, urlDriveRaw) {
  const result = { integridad: 'ERROR', hashWeb: '', hashMaestro: '', detalle: '', urlFtDrive: '' };

  // Construir URL completa del PDF web: base + nombre de archivo
  let urlWeb = '';
  if (urlFtBase) {
    // Si col9 ya termina en extensión de archivo (.pdf, .PDF, .xlsx, etc.)
    // es una URL completa — no concatenar col10
    const isCompleteUrl = /\.\w{2,5}$/i.test(urlFtBase.split('?')[0].split('#')[0]);
    if (isCompleteUrl || !nombreArchivo) {
      urlWeb = urlFtBase;
    } else {
      // col9 es base path, col10 es el nombre del archivo
      const base = urlFtBase.endsWith('/') ? urlFtBase : urlFtBase + '/';
      urlWeb = base + nombreArchivo;
    }
  }

  result.urlFtDrive = urlDriveRaw || '';
  const urlDrive = normalizeDriveUrl(urlDriveRaw);

  const [webRes, driveRes] = await Promise.allSettled([
    urlWeb   ? downloadBufferWithCache(urlWeb)   : Promise.reject(new Error('Sin URL FT web')),
    urlDrive ? downloadBufferWithCache(urlDrive) : Promise.reject(new Error('Sin Link FT Drive'))
  ]);

  const errs = [];
  if (webRes.status === 'fulfilled') {
    result.hashWeb = await contentHash(webRes.value);
  } else {
    errs.push(`PDF web: ${webRes.reason?.message || webRes.reason}`);
  }
  if (driveRes.status === 'fulfilled') {
    result.hashMaestro = await contentHash(driveRes.value);
  } else {
    errs.push(`PDF Drive: ${driveRes.reason?.message || driveRes.reason}`);
  }

  if (result.hashWeb && result.hashMaestro) {
    result.integridad = result.hashWeb === result.hashMaestro ? 'OK' : 'DESACTUALIZADO';
    result.detalle    = result.integridad === 'OK'
      ? 'Hash SHA-256 coincide.'
      : 'El PDF publicado NO coincide con el maestro de Drive.';
  } else {
    result.integridad = 'ERROR';
    result.detalle    = errs.join(' | ') || 'No se pudieron descargar los PDFs.';
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
    { header: 'Link FT Drive (maestro)',     key: 'urlFtDrive',      width: 80 }
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
    if (val === 'SIN_IMAGEN')              return 'FFDCE6F1';
    return 'FFFFC7CE';
  };

  results.forEach((r) => {
    const row = ws.addRow({
      sku: r.sku, textoComercial: r.textoComercial, urlFamiq: r.urlProducto,
      integridad: r.integridad, hashWeb: r.hashWeb, hashMaestro: r.hashMaestro, urlFtDrive: r.urlFtDrive || '',
      estadoVisual: r.estadoVisual, analisisVisual: r.analisisVisual,
      estadoTecnico: r.estadoTecnico, validaciones: r.validaciones,
      discrepancias: r.discrepancias, recomendaciones: r.recomendaciones,
      propuesta: r.propuesta, urlFtDrive: r.urlFtDrive || ''
    });
    row.alignment = { vertical: 'top', wrapText: true };

    const paint = (key, argb) => {
      if (!argb) return;
      row.getCell(key).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    };
    paint('integridad',   colorFor(r.integridad));
    paint('estadoVisual', colorFor(r.estadoVisual));
    paint('estadoTecnico',colorFor(r.estadoTecnico));

    if (r.urlProducto) {
      const c = row.getCell('urlFamiq');
      c.value = { text: r.urlProducto, hyperlink: r.urlProducto };
    if (r.urlFtDrive) {
      const cft = row.getCell('urlFtDrive');
      cft.value = { text: r.urlFtDrive, hyperlink: r.urlFtDrive };
      cft.font  = { color: { argb: 'FF0563C1' }, underline: true };
    }
      c.font  = { color: { argb: 'FF0563C1' }, underline: true };
    }
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
    recomendaciones: '', propuesta: ''
  };

  // 1) Integridad PDF (con cache — si el mismo PDF aparece en varias filas, se descarga una sola vez)
  try {
    const pdf = await checkPdfIntegrity(row.urlFtBase, row.nombreArchivo, row.linkFtDrive);
    base.integridad  = pdf.integridad;
    base.hashWeb     = pdf.hashWeb;
    base.hashMaestro = pdf.hashMaestro;
    base.urlFtDrive  = pdf.urlFtDrive || row.linkFtDrive || '';
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
      const key = String(row.id || row.sku || row.rowNumber);
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
          recomendaciones: '', propuesta: ''
        };
        done++;
        console.error(`[err ${done}/${rows.length}] ${row.sku}: ${err?.message || err}`);
      } finally {
        saveCheckpoint({ results });
      }
    })
  );

  await Promise.all(tasks);

  const ordered = rows.map((r) => results[String(r.id || r.sku || r.rowNumber)]).filter(Boolean);
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


