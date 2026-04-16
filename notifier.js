// notifier.js
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

const DRIVE_FOLDER_NAME = 'Reportes PDF Auditor';
const DEFAULT_RECIPIENT = 'jortiz@famiq.com.ar';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

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

export async function uploadToDrive(excelPath) {
  const auth = new google.auth.GoogleAuth({ scopes: DRIVE_SCOPES });
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

  try {
    await drive.permissions.create({
      fileId: resp.data.id,
      requestBody: { role: 'reader', type: 'anyone' }
    });
  } catch (_) {}

  return {
    fileId: resp.data.id,
    name: resp.data.name,
    webViewLink: resp.data.webViewLink,
    webContentLink: resp.data.webContentLink
  };
}

export async function notify(excelPath, opts = {}) {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`No existe el archivo de reporte: ${excelPath}`);
  }

  let driveInfo = null;
  try {
    driveInfo = await uploadToDrive(excelPath);
    console.log(
      `[notifier] Subido a Drive: ${driveInfo.name} (${driveInfo.fileId}) -> ${driveInfo.webViewLink}`
    );
  } catch (err) {
    console.error(`[notifier] Error subiendo a Drive: ${err?.message || err}`);
  }

  // Gmail via API de service account requiere domain-wide delegation
  // que no está disponible en este proyecto. Se loguea el link y se omite el mail.
  if (driveInfo?.webViewLink) {
    console.log(`[notifier] Reporte disponible en Drive: ${driveInfo.webViewLink}`);
  } else {
    console.warn('[notifier] No se pudo subir a Drive. El reporte queda como artifact en Actions.');
  }

  return { drive: driveInfo, mail: { ok: false, error: 'Gmail API no configurada' } };
}

export default notify;
