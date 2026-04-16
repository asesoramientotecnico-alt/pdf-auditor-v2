// index.js
// Orquestador principal del Agente Auditor de Calidad Web.
//
// Flujo:
//  1. Lee el Google Sheet (ID fijo) via Sheets API con cuenta de servicio.
//  2. Por cada fila (concurrencia 5 con p-limit):
//       a. Descarga el PDF publicado (col 9) y el PDF maestro de Drive (col 11).
//       b. Compara SHA-256 y marca "Integridad PDF".
//       c. Scrapea la URL de producto (col 6) con Puppeteer.
//       d. Envia el resultado al Inspector IA (agent.js / Gemini 1.5 Flash).
//       e. Guarda el resultado en memoria.
//  3. Usa checkpoint.json para reanudar si el proceso se corta.
//  4. Genera Reporte_Auditoria_IA.xlsx.
//  5. Invoca notifier.js para subir el Excel a Drive y mandarlo por mail.

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

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1Yn5-1a5BqnVoNch5Cifn_5lsvhYJM1L7';
const INPUT_SHEET    = process.env.INPUT_SHEET    || 'Hoja2';
const OUTPUT_XLSX    = process.env.OUTPUT_XLSX    || 'Reporte_Auditoria_IA.xlsx';
const CHECKPOINT_FILE = process.env.CHECKPOINT_FILE || 'checkpoint.json';
const CONCURRENCY    = parseInt(process.env.CONCURRENCY || '5', 10);
const RECIPIENT      = process.env.REPORT_RECIPIENT || 'jortiz@famiq.com.ar';
const CREDENTIALS_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(process.cwd(), 'credentials.json');

const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// -------------------- utilidades --------------------

function col(row, oneBasedIndex) {
  const v = row[oneBasedIndex - 1];
  return v == null ? '' : String(v).trim();
}

/**
 * Convierte un link tipo https://drive.google.com/file/d/ID/view?usp=drive_link
 * a https://drive.google.com/uc?export=download&id=ID
 */
export function normalizeDriveUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';
  const m = s.match(/\/file\/d\/([^/]+)/) || s.match(/[?&]id=([^&]+)/);
  if (m && m[1]) {
    return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  }
  return s;
}

async function downloadBuffer(url, { timeout = 60000 } = {}) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout,
    maxRedirects: 10,
    httpsAgent: insecureAgent,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    }
  });
  return Buffer.from(res.data);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Descarga los dos PDFs, calcula hashes y compara.
 */
async function checkPdfIntegrity(urlWeb, urlDriveRaw) {
  const result = {
    integridad: 'ERROR',
    hashWeb: '',
    hashMaestro: '',
    detalle: ''
  };

  const urlDrive = normalizeDriveUrl(urlDriveRaw);

  const [webRes, driveRes] = await Promise.allSettled([
    urlWeb ? downloadBuffer(urlWeb) : Promise.reject(new Error('Sin URL FT web')),
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
    if (result.hashWeb === result.hashMaestro) {
      result.integridad = 'OK';
      result.detalle = 'Hash SHA-256 coincide.';
    } else {
      result.integridad = 'DESACTUALIZADO';
      result.detalle = 'El PDF publicado no coincide con el maestro de Drive.';
    }
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
      const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
      const json = JSON.parse(raw);
      if (json && typeof json === 'object' && json.results) return json;
    }
  } catch (err) {
    console.warn(`[checkpoint] No se pudo leer ${CHECKPOINT_FILE}: ${err?.message || err}`);
  }
  return { results: {} };
}

function saveCheckpoint(state) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[checkpoint] No se pudo escribir ${CHECKPOINT_FILE}: ${err?.message || err}`);
  }
}

// -------------------- Google Sheets --------------------

async function readSheetRows(spreadsheetId, sheetName) {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: SHEETS_SCOPES
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const range = `${sheetName}`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });

  const rawRows = resp.data.values || [];
  if (rawRows.length === 0) throw new Error(`La hoja "${sheetName}" esta vacia.`);

  // Fila 0 = cabecera; filas siguientes = datos.
  const rows = [];
  rawRows.slice(1).forEach((r, i) => {
    const rowNumber = i + 2; // 1-based, saltando cabecera
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

async function writeReport(filePath, results) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Agente Auditor de Calidad Web';
  wb.created = new Date();
  const ws = wb.addWorksheet('Auditoria');

  ws.columns = [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Descripcion', key: 'descripcion', width: 45 },
    { header: 'URL Famiq', key: 'urlFamiq', width: 55 },
    { header: 'Resultado Integridad PDF', key: 'integridad', width: 22 },
    { header: 'Hash Web', key: 'hashWeb', width: 66 },
    { header: 'Hash Maestro', key: 'hashMaestro', width: 66 },
    { header: 'Estado Coherencia Visual', key: 'estadoVisual', width: 24 },
    { header: 'Analisis de Imagen', key: 'analisisVisual', width: 55 },
    { header: 'Estado Consistencia Tecnica', key: 'estadoTecnico', width: 26 },
    { header: 'Discrepancias', key: 'discrepancias', width: 55 },
    { header: 'Propuesta de Correccion', key: 'propuesta', width: 55 }
  ];

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E78' }
  };
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };

  const colorFor = (val, okList) => {
    if (!val) return null;
    return okList.includes(val) ? 'FFC6EFCE' : 'FFFFC7CE';
  };

  results.forEach((r) => {
    const row = ws.addRow({
      sku: r.sku,
      descripcion: r.descripcion,
      urlFamiq: r.urlProducto,
      integridad: r.integridad,
      hashWeb: r.hashWeb,
      hashMaestro: r.hashMaestro,
      estadoVisual: r.estadoVisual,
      analisisVisual: r.analisisVisual,
      estadoTecnico: r.estadoTecnico,
      discrepancias: r.discrepancias,
      propuesta: r.propuesta
    });
    row.alignment = { vertical: 'top', wrapText: true };

    const paint = (colKey, color) => {
      if (!color) return;
      row.getCell(colKey).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: color }
      };
    };

    paint('integridad', colorFor(r.integridad, ['OK']));
    paint('estadoVisual', colorFor(r.estadoVisual, ['COHERENTE']));
    paint('estadoTecnico', colorFor(r.estadoTecnico, ['OK']));
  });

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: ws.columns.length }
  };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  await wb.xlsx.writeFile(filePath);
}

// -------------------- pipeline por fila --------------------

async function processRow(row, browser) {
  const base = {
    sku: row.sku,
    descripcion: row.descripcion,
    urlProducto: row.urlProducto,
    integridad: 'ERROR',
    hashWeb: '',
    hashMaestro: '',
    estadoVisual: 'ERROR',
    analisisVisual: '',
    estadoTecnico: 'ERROR',
    discrepancias: '',
    propuesta: ''
  };

  // 1) Integridad PDF
  try {
    const pdf = await checkPdfIntegrity(row.urlFtWeb, row.linkFtDrive);
    base.integridad = pdf.integridad;
    base.hashWeb = pdf.hashWeb;
    base.hashMaestro = pdf.hashMaestro;
    if (pdf.detalle && pdf.integridad !== 'OK') {
      base.discrepancias = `[Integridad PDF] ${pdf.detalle}`;
    }
  } catch (err) {
    base.integridad = 'ERROR';
    base.discrepancias = `[Integridad PDF] ${err?.message || err}`;
  }

  // 2) Scrape de la pagina
  let scrape = null;
  if (row.urlProducto) {
    scrape = await scrapeProduct(row.urlProducto, browser);
  } else {
    scrape = { error: 'Fila sin URL de producto.' };
  }

  // 3) Auditoria con Gemini
  const audit = await auditScrape(scrape, { descripcionMaestra: row.descripcion });
  base.estadoVisual = audit.estado_visual;
  base.analisisVisual = audit.analisis_visual;
  base.estadoTecnico = audit.estado_tecnico;
  // Concatenamos discrepancias del PDF con las del agente si aplican.
  const agentDisc = audit.discrepancias || '';
  if (base.discrepancias && agentDisc) {
    base.discrepancias = `${base.discrepancias} | [IA] ${agentDisc}`;
  } else if (agentDisc) {
    base.discrepancias = agentDisc;
  }
  base.propuesta = audit.propuesta_correccion || '';

  return base;
}

// -------------------- main --------------------

async function main() {
  console.log('=== Agente Auditor de Calidad Web ===');
  console.log(`Entrada: Google Sheets ${SPREADSHEET_ID} (hoja "${INPUT_SHEET}")`);
  console.log(`Salida:  ${OUTPUT_XLSX}`);
  console.log(`Concurrencia: ${CONCURRENCY}`);

  if (!process.env.GEMINI_API_KEY) {
    console.warn('[warn] GEMINI_API_KEY no esta seteada. El agente IA devolvera ERROR.');
  }

  const rows = await readSheetRows(SPREADSHEET_ID, INPUT_SHEET);
  console.log(`Filas a auditar: ${rows.length}`);

  const checkpoint = loadCheckpoint();
  const results = checkpoint.results || {};

  const browser = await launchBrowser();
  const limit = pLimit(CONCURRENCY);

  let done = 0;
  const total = rows.length;

  const tasks = rows.map((row) =>
    limit(async () => {
      const key = String(row.id || row.sku || row.rowNumber);

      if (results[key]) {
        done++;
        console.log(`[skip ${done}/${total}] ${row.sku || row.id} (checkpoint)`);
        return;
      }

      try {
        const res = await processRow(row, browser);
        results[key] = res;
        done++;
        console.log(
          `[ok ${done}/${total}] ${row.sku || row.id} ` +
            `pdf=${res.integridad} visual=${res.estadoVisual} tec=${res.estadoTecnico}`
        );
      } catch (err) {
        results[key] = {
          sku: row.sku,
          descripcion: row.descripcion,
          urlProducto: row.urlProducto,
          integridad: 'ERROR',
          hashWeb: '',
          hashMaestro: '',
          estadoVisual: 'ERROR',
          analisisVisual: `Fallo inesperado: ${err?.message || err}`,
          estadoTecnico: 'ERROR',
          discrepancias: '',
          propuesta: ''
        };
        done++;
        console.error(`[err ${done}/${total}] ${row.sku || row.id}: ${err?.message || err}`);
      } finally {
        // Persistimos despues de cada fila para poder reanudar.
        saveCheckpoint({ results });
      }
    })
  );

  await Promise.all(tasks);

  try {
    await browser.close();
  } catch (_) {}

  // Mantener el orden de las filas de entrada en el reporte.
  const ordered = rows
    .map((r) => results[String(r.id || r.sku || r.rowNumber)])
    .filter(Boolean);

  const outPath = path.resolve(process.cwd(), OUTPUT_XLSX);
  await writeReport(outPath, ordered);
  console.log(`Reporte generado: ${outPath}`);

  // Notificar (Drive + Gmail).
  try {
    await notify(outPath, { to: RECIPIENT });
  } catch (err) {
    console.error(`[notifier] Error: ${err?.message || err}`);
  }

  // Si todo salio bien, borramos el checkpoint.
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
  } catch (_) {}

  console.log('=== Fin de la auditoria ===');
}

main().catch((err) => {
  console.error('Fallo general:', err);
  process.exitCode = 1;
});
