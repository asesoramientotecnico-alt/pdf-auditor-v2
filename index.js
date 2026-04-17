// index.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import axios from 'axios';
import ExcelJS from 'exceljs';
import pLimit from 'p-limit';
import { google } from 'googleapis';

import { launchBrowser, scrapeProduct } from './scraper.js';
import { auditScrape } from './agent.js';
import { notify } from './notifier.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SPREADSHEET_ID  = process.env.SPREADSHEET_ID  || '1Yn5-1a5BqnVoNch5Cifn_5lsvhYJM1L7';
const INPUT_SHEET     = process.env.INPUT_SHEET     || 'Hoja2';
const OUTPUT_XLSX     = process.env.OUTPUT_XLSX     || 'Reporte_Auditoria_IA.xlsx';
const CHECKPOINT_FILE = process.env.CHECKPOINT_FILE || 'checkpoint.json';
const CONCURRENCY     = parseInt(process.env.CONCURRENCY || '5', 10);
// Máximo de llamadas a Gemini por minuto (límite pago: 10 RPM para Flash)
// Usamos 8 para dejar margen de seguridad
const GEMINI_RPM      = parseInt(process.env.GEMINI_RPM || '8', 10);
const RECIPIENT       = process.env.REPORT_RECIPIENT || 'jortiz@famiq.com.ar';

const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// -------------------- Semáforo Gemini --------------------
// Controla que no se envíen más de GEMINI_RPM requests por minuto a Gemini,
// independientemente de cuántas filas se procesen en paralelo.

const geminiSlots = pLimit(1); // solo 1 request a Gemini a la vez
const GEMINI_INTERVAL_MS = Math.ceil(60000 / GEMINI_RPM); // ms entre requests

let lastGeminiCall = 0;

async function rateLimitedAudit(scrape, opts) {
  return geminiSlots(async () => {
    const now = Date.now();
    const elapsed = now - lastGeminiCall;
    if (elapsed < GEMINI_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, GEMINI_INTERVAL_MS - elapsed));
    }
    lastGeminiCall = Date.now();
    return auditScrape(scrape, opts);
  });
}

// -------------------- utilidades --------------------

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

async function downloadBuffer(url, { timeout = 60000, retries = 3 } = {}) {
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
        }
      });
      return Buffer.from(res.data);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = 10000 * attempt; // 10s, 20s
        console.warn(`[pdf] intento ${attempt}/${retries} fallido para ${url.slice(0,80)}, reintentando en ${wait/1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function checkPdfIntegrity(urlWeb, urlDriveRaw) {
  const result = { integridad: 'ERROR', hashWeb: '', hashMaestro: '', detalle: '' };
  const urlDrive = normalizeDriveUrl(urlDriveRaw);

  const [webRes, driveRes] = await Promise.allSettled([
    urlWeb   ? downloadBuffer(urlWeb)   : Promise.reject(new Error('Sin URL FT web')),
    urlDrive ? downloadBuffer(urlDrive) : Promise.reject(new Error('Sin Link FT Drive'))
  ]);

  const errs = [];
  if (webRes.status === 'fulfilled') {
    result.hashWeb = sha256(webRes.value);
  } else {
    errs.push(`PDF web: ${webRes.reason?.message || webRes.reason}`);
  }
  if (driveRes.status === 'fulfilled') {
    result.hashMaestro = sha256(driveRes.value);
  } else {
    errs.push(`PDF Drive: ${driveRes.reason?.message || driveRes.reason}`);
  }

  if (result.hashWeb && result.hashMaestro) {
    result.integridad = result.hashWeb === result.hashMaestro ? 'OK' : 'DESACTUALIZADO';
    result.detalle = result.integridad === 'OK'
      ? 'Hash SHA-256 coincide.'
      : 'El PDF publicado NO coincide con el maestro de Drive.';
  } else {
    result.integridad = 'ERROR';
    result.detalle = errs.join(' | ') || 'No se pudieron descargar los PDFs.';
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
  const auth = new google.auth.GoogleAuth({ scopes: SHEETS_SCOPES });
  const sheets = google.sheets({ version: 'v4', auth });
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const rawRows = resp.data.values || [];
  if (rawRows.length === 0) throw new Error(`La hoja "${sheetName}" esta vacia.`);

  const rows = [];
  rawRows.slice(1).forEach((r, i) => {
    const rowNumber   = i + 2;
    const id          = col(r, 1);
    const sku         = col(r, 2);
    const descripcion = col(r, 3);
    const urlProducto = col(r, 6);
    const urlFtWeb    = col(r, 9);
    const linkFtDrive = col(r, 11);
    if (!id && !sku && !urlProducto && !urlFtWeb && !linkFtDrive) return;
    rows.push({ rowNumber, id, sku, descripcion, urlProducto, urlFtWeb, linkFtDrive });
  });
  return rows;
}

// -------------------- reporte Excel --------------------

async function writeReport(filePath, results) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Agente Auditor de Calidad Web';
  wb.created = new Date();
  const ws = wb.addWorksheet('Auditoria');

  ws.columns = [
    { header: 'SKU',                        key: 'sku',             width: 18 },
    { header: 'Texto Comercial Maestro',     key: 'descripcion',     width: 45 },
    { header: 'URL Famiq',                   key: 'urlFamiq',        width: 55 },
    { header: 'Integridad PDF',              key: 'integridad',      width: 18 },
    { header: 'Hash Web',                    key: 'hashWeb',         width: 66 },
    { header: 'Hash Maestro (Drive)',        key: 'hashMaestro',     width: 66 },
    { header: 'Estado Coherencia Visual',    key: 'estadoVisual',    width: 22 },
    { header: 'Analisis de Imagen',          key: 'analisisVisual',  width: 55 },
    { header: 'Estado Consistencia Tecnica', key: 'estadoTecnico',   width: 24 },
    { header: 'Validaciones',                key: 'validaciones',    width: 60 },
    { header: 'Discrepancias',               key: 'discrepancias',   width: 60 },
    { header: 'Recomendaciones',             key: 'recomendaciones', width: 55 },
    { header: 'Propuesta de Correccion',     key: 'propuesta',       width: 55 }
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
      sku: r.sku, descripcion: r.descripcion, urlFamiq: r.urlProducto,
      integridad: r.integridad, hashWeb: r.hashWeb, hashMaestro: r.hashMaestro,
      estadoVisual: r.estadoVisual, analisisVisual: r.analisisVisual,
      estadoTecnico: r.estadoTecnico, validaciones: r.validaciones,
      discrepancias: r.discrepancias,
      recomendaciones: r.recomendaciones, propuesta: r.propuesta
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
    sku: row.sku, descripcion: row.descripcion, urlProducto: row.urlProducto,
    integridad: 'ERROR', hashWeb: '', hashMaestro: '',
    estadoVisual: 'ERROR', analisisVisual: '',
    estadoTecnico: 'ERROR', discrepancias: '', validaciones: '', recomendaciones: '', propuesta: ''
  };

  // 1) Integridad PDF
  try {
    const pdf = await checkPdfIntegrity(row.urlFtWeb, row.linkFtDrive);
    base.integridad  = pdf.integridad;
    base.hashWeb     = pdf.hashWeb;
    base.hashMaestro = pdf.hashMaestro;
    if (pdf.detalle && pdf.integridad !== 'OK') {
      base.discrepancias = `[PDF] ${pdf.detalle}`;
    }
  } catch (err) {
    base.integridad    = 'ERROR';
    base.discrepancias = `[PDF] ${err?.message || err}`;
  }

  // 2) Scrape
  const scrape = row.urlProducto
    ? await scrapeProduct(row.urlProducto, browser)
    : { error: 'Fila sin URL de producto.' };

  // 3) Auditoria Gemini — con rate limiter (max GEMINI_RPM por minuto)
  const audit = await rateLimitedAudit(scrape, { descripcionMaestra: row.descripcion });
  base.estadoVisual    = audit.estado_visual;
  base.analisisVisual  = audit.analisis_visual;
  base.estadoTecnico   = audit.estado_tecnico;
  base.recomendaciones = audit.recomendaciones || '';
  base.validaciones    = audit.validaciones    || '';

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
  console.log(`Salida: ${OUTPUT_XLSX} | Concurrencia scraping: ${CONCURRENCY} | Gemini RPM: ${GEMINI_RPM}`);

  if (!process.env.GEMINI_API_KEY) console.warn('[warn] GEMINI_API_KEY no seteada.');

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
          sku: row.sku, descripcion: row.descripcion, urlProducto: row.urlProducto,
          integridad: 'ERROR', hashWeb: '', hashMaestro: '',
          estadoVisual: 'ERROR', analisisVisual: `Fallo: ${err?.message || err}`,
          estadoTecnico: 'ERROR', discrepancias: '', validaciones: '', recomendaciones: '', propuesta: ''
        };
        done++;
        console.error(`[err ${done}/${rows.length}] ${row.sku}: ${err?.message || err}`);
      } finally {
        saveCheckpoint({ results });
      }
    })
  );

  await Promise.all(tasks);
  try { await browser.close(); } catch (_) {}

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


