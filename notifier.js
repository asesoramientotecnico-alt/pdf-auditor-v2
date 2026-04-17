// notifier.js
// Sube el reporte a SharePoint (OneDrive) via Microsoft Graph API
// Auth: Resource Owner Password Credentials (usuario/contraseña corporativo)

import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

const SHAREPOINT_SITE   = 'famiq.sharepoint.com';
const SITE_PATH         = '/sites/OficinaTcnica';
const FOLDER_PATH       = 'Documentos compartidos/2026/Documentacion Famiq/PIN';
const TENANT            = 'famiq.com.ar'; // se usa para el token endpoint

async function getAccessToken(user, pass) {
  // Intentar con tenant domain primero, luego con 'common'
  const tenantIds = [TENANT, 'common'];
  let lastErr;

  for (const tenant of tenantIds) {
    try {
      const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
      const params = new URLSearchParams({
        grant_type:    'password',
        client_id:     '1b730954-1685-4b74-9bfd-dac224a7b894', // client_id público de OneDrive
        scope:         'https://graph.microsoft.com/.default offline_access',
        username:      user,
        password:      pass,
      });
      const res = await axios.post(url, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000
      });
      return res.data.access_token;
    } catch (err) {
      lastErr = err?.response?.data || err?.message;
      continue;
    }
  }
  throw new Error(`No se pudo obtener token: ${JSON.stringify(lastErr)}`);
}

async function getSiteId(token) {
  const url = `https://graph.microsoft.com/v1.0/sites/${SHAREPOINT_SITE}:${SITE_PATH}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000
  });
  return res.data.id;
}

async function getDefaultDriveId(token, siteId) {
  // Obtener el drive principal del sitio SharePoint
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drives`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000
  });
  // Usar el drive "Documents" o el primero disponible
  const drives = res.data.value || [];
  const doc = drives.find(d => d.name === 'Documents' || d.name === 'Documentos compartidos') || drives[0];
  if (!doc) throw new Error('No se encontró ningún drive en el sitio');
  console.log(`[notifier] Drive: ${doc.name} (${doc.id})`);
  return doc.id;
}

async function uploadFile(token, siteId, localPath, remoteName) {
  const fileBuffer = fs.readFileSync(localPath);
  const driveId = await getDefaultDriveId(token, siteId);

  // La ruta debe ser relativa al root del drive (sin "Documentos compartidos")
  const folderRelative = FOLDER_PATH.replace(/^Documentos compartidos\/?/, '');
  const filePath = folderRelative ? `${folderRelative}/${remoteName}` : remoteName;
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');

  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedPath}:/content`;
  console.log(`[notifier] URL upload: ${url.slice(0, 120)}...`);

  const res = await axios.put(url, fileBuffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    },
    timeout: 30000,
    maxBodyLength: 10 * 1024 * 1024
  });
  return res.data;
}

export async function notify(excelPath, opts = {}) {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`No existe el archivo de reporte: ${excelPath}`);
  }

  const user = process.env.ONEDRIVE_USER;
  const pass = process.env.ONEDRIVE_PASS;

  if (!user || !pass) {
    console.warn('[notifier] ONEDRIVE_USER / ONEDRIVE_PASS no configurados. El reporte queda como artifact en Actions.');
    return { sharepoint: null };
  }

  try {
    // Nombre con fecha para mantener historial
    const fecha = new Date().toISOString().slice(0, 10); // 2026-04-17
    const remoteName = `Reporte_Auditoria_IA_${fecha}.xlsx`;

    console.log('[notifier] Obteniendo token SharePoint...');
    const token = await getAccessToken(user, pass);

    console.log('[notifier] Obteniendo Site ID...');
    const siteId = await getSiteId(token);

    // 1) Archivo fijo — siempre el mismo nombre, para queries y dashboards
    const fixedName = 'Reporte_Auditoria_IA.xlsx';
    console.log(`[notifier] Subiendo archivo fijo: ${fixedName}...`);
    const resultFijo = await uploadFile(token, siteId, excelPath, fixedName);
    const linkFijo = resultFijo.webUrl || resultFijo['@microsoft.graph.downloadUrl'] || '';
    console.log(`[notifier] ✅ Archivo fijo subido: ${fixedName}`);

    // 2) Archivo histórico — nombre con fecha
    console.log(`[notifier] Subiendo archivo histórico: ${remoteName}...`);
    const resultHist = await uploadFile(token, siteId, excelPath, remoteName);
    const linkHist = resultHist.webUrl || resultHist['@microsoft.graph.downloadUrl'] || '';
    console.log(`[notifier] ✅ Archivo histórico subido: ${remoteName}`);
    if (linkFijo) console.log(`[notifier] Link fijo: ${linkFijo}`);
    if (linkHist) console.log(`[notifier] Link histórico: ${linkHist}`);

    return { sharepoint: { fixed: { name: fixedName, url: linkFijo }, historic: { name: remoteName, url: linkHist } } };
  } catch (err) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.message;
    console.error(`[notifier] Error subiendo a SharePoint: ${detail}`);
    console.warn('[notifier] El reporte queda como artifact en Actions.');
    return { sharepoint: null };
  }
}

export default notify;
