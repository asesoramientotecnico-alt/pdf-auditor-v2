// notifier.js
// Sube el Reporte_Auditoria_IA.xlsx a Google Drive (carpeta "Reportes PDF Auditor")
// y envia un mail a jortiz@famiq.com.ar con el Excel adjunto.
// Usa una cuenta de servicio (credentials.json).

import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

const DEFAULT_CREDENTIALS_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.resolve(process.cwd(), 'credentials.json');

const DRIVE_FOLDER_NAME = 'Reportes PDF Auditor';
const DEFAULT_RECIPIENT = 'jortiz@famiq.com.ar';
const DEFAULT_SENDER = 'pdf-auditor-bot@pdf-auditor.iam.gserviceaccount.com';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.send'
];

/**
 * Construye un cliente JWT autenticado con la cuenta de servicio.
 * Si se pasa subject, delega (domain-wide delegation) para poder enviar mail.
 */
function buildAuth({ credentialsPath = DEFAULT_CREDENTIALS_PATH, subject } = {}) {
  const raw = fs.readFileSync(credentialsPath, 'utf8');
  const creds = JSON.parse(raw);
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
    subject: subject || undefined
  });
}

/**
 * Busca (o crea) la carpeta de reportes en el Drive de la cuenta de servicio.
 */
async function ensureReportsFolder(drive) {
  const q = [
    `name = '${DRIVE_FOLDER_NAME.replace(/'/g, "\\'")}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `trashed = false`
  ].join(' and ');

  const found = await drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive'
  });

  if (found.data.files && found.data.files.length > 0) {
    return found.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: {
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id'
  });
  return created.data.id;
}

/**
 * Sube el Excel a la carpeta de reportes y retorna { fileId, webViewLink }.
 */
export async function uploadToDrive(excelPath, { auth } = {}) {
  const drive = google.drive({ version: 'v3', auth });
  const folderId = await ensureReportsFolder(drive);
  const fileName = path.basename(excelPath);

  const resp = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: XLSX_MIME
    },
    media: {
      mimeType: XLSX_MIME,
      body: fs.createReadStream(excelPath)
    },
    fields: 'id, name, webViewLink, webContentLink'
  });

  // Lo dejamos accesible al que tenga el link (opcional pero util para auditoria).
  try {
    await drive.permissions.create({
      fileId: resp.data.id,
      requestBody: { role: 'reader', type: 'anyone' }
    });
  } catch (_) {
    // Si la org lo bloquea, seguimos igual.
  }

  return {
    fileId: resp.data.id,
    name: resp.data.name,
    webViewLink: resp.data.webViewLink,
    webContentLink: resp.data.webContentLink
  };
}

/**
 * Construye un mensaje RFC 2822 con adjunto (multipart/mixed) y lo codifica en base64url.
 */
function buildRawMime({ from, to, subject, text, attachmentPath, attachmentMime }) {
  const boundary = '=_BOUNDARY_' + Date.now().toString(16);
  const fileName = path.basename(attachmentPath);
  const fileContent = fs.readFileSync(attachmentPath).toString('base64');

  // Envolver el contenido base64 a 76 chars por linea (estandar MIME).
  const wrap = (s) => s.replace(/.{1,76}/g, (m) => m + '\r\n').trim();

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ].join('\r\n');

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    '',
    `--${boundary}`,
    `Content-Type: ${attachmentMime}; name="${fileName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${fileName}"`,
    '',
    wrap(fileContent),
    `--${boundary}--`,
    ''
  ].join('\r\n');

  const raw = `${headers}\r\n\r\n${body}`;

  // base64url
  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Envia el mail. Intenta primero con Gmail API (usando domain-wide delegation).
 * Si no esta disponible DWD en la cuenta, el envio via Gmail API fallara: en ese caso
 * se loguea el error pero no se rompe la ejecucion.
 */
export async function sendReportEmail({
  excelPath,
  driveLink,
  to = DEFAULT_RECIPIENT,
  from = process.env.GMAIL_SENDER || DEFAULT_SENDER,
  subject = 'Reporte Auditoria IA - Famiq',
  credentialsPath = DEFAULT_CREDENTIALS_PATH,
  impersonate = process.env.GMAIL_IMPERSONATE || ''
} = {}) {
  const text =
    'Hola,\n\n' +
    'Adjuntamos el reporte de auditoria automatica de fichas tecnicas publicadas en famiq.com.ar.\n' +
    (driveLink ? `Copia en Google Drive: ${driveLink}\n\n` : '\n') +
    'Este mail fue generado automaticamente por el Agente Auditor de Calidad Web.\n';

  const auth = buildAuth({ credentialsPath, subject: impersonate || undefined });
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = buildRawMime({
    from,
    to,
    subject,
    text,
    attachmentPath: excelPath,
    attachmentMime: XLSX_MIME
  });

  try {
    const resp = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw }
    });
    return { ok: true, id: resp.data.id };
  } catch (err) {
    const msg = err?.errors?.[0]?.message || err?.message || String(err);
    console.warn(`[notifier] No se pudo enviar el mail via Gmail API: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Flujo completo: sube a Drive y manda el mail.
 *
 * @param {string} excelPath Ruta absoluta al Reporte_Auditoria_IA.xlsx
 * @param {{to?:string, credentialsPath?:string}} [opts]
 */
export async function notify(excelPath, opts = {}) {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`No existe el archivo de reporte: ${excelPath}`);
  }

  const credentialsPath = opts.credentialsPath || DEFAULT_CREDENTIALS_PATH;
  const auth = buildAuth({ credentialsPath });

  let driveInfo = null;
  try {
    driveInfo = await uploadToDrive(excelPath, { auth });
    console.log(
      `[notifier] Subido a Drive: ${driveInfo.name} (${driveInfo.fileId}) -> ${driveInfo.webViewLink}`
    );
  } catch (err) {
    console.error(`[notifier] Error subiendo a Drive: ${err?.message || err}`);
  }

  const mail = await sendReportEmail({
    excelPath,
    driveLink: driveInfo?.webViewLink || '',
    to: opts.to || DEFAULT_RECIPIENT,
    credentialsPath
  });
  if (mail.ok) {
    console.log(`[notifier] Mail enviado a ${opts.to || DEFAULT_RECIPIENT} (id=${mail.id}).`);
  }

  return { drive: driveInfo, mail };
}

export default notify;
