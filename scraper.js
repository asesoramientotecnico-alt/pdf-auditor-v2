// scraper.js
// famiq.com.ar es una SPA que carga datos via /producto/{id}/data?nodo=null
// Interceptamos esa respuesta directamente en lugar de parsear el DOM.

import puppeteer from 'puppeteer';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NAV_TIMEOUT_MS = 60000;

export async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-zygote', '--single-process',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}

export async function scrapeProduct(url, externalBrowser = null) {
  let browser = externalBrowser;
  let ownsBrowser = false;
  if (!browser) { browser = await launchBrowser(); ownsBrowser = true; }

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-AR,es;q=0.9' });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Interceptar la llamada a /data?nodo=null
    let productoData = null;
    page.on('response', async (response) => {
      const respUrl = response.url();
      if (
        response.status() === 200 &&
        respUrl.includes('/data') &&
        respUrl.includes('nodo=')
      ) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            productoData = await response.json();
          }
        } catch (_) {}
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Esperar a que llegue la respuesta de la API (máx 15s)
    const waitStart = Date.now();
    while (!productoData && Date.now() - waitStart < 15000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!productoData) {
      console.warn(`[scraper] No se recibió /data para ${url}`);
      return { url, titulo: '', imagen: null, especificaciones: {}, error: 'API /data no respondió' };
    }

    // Loguear estructura completa para debug (solo primera vez)
    console.log(`[scraper] ${url} -> API keys: ${Object.keys(productoData).join(',')}`);

    // Extraer campos del JSON de la API
    const titulo = productoData.nombre || productoData.titulo || productoData.descripcion_corta || '';

    const especificaciones = {};

    // caracteristicas es un array o un objeto con las specs técnicas
    const caract = productoData.caracteristicas;
    if (Array.isArray(caract)) {
      caract.forEach((item) => {
        // cada item puede ser {nombre, valor} o {label, value} o similar
        const k = item.nombre || item.label || item.key || item.titulo || '';
        const v = item.valor || item.value || item.descripcion || '';
        if (k && v) especificaciones[k] = String(v);
      });
    } else if (caract && typeof caract === 'object') {
      Object.entries(caract).forEach(([k, v]) => {
        if (k && v) especificaciones[k] = String(v);
      });
    }

    // descripcion larga
    const desc = productoData.descripcion_larga || productoData.descripcion || productoData.texto || '';
    if (desc) especificaciones['__descripcion_larga__'] = String(desc).slice(0, 4000);

    // SKU/codigo
    const sku = productoData.codigo || productoData.sku || '';
    if (sku) especificaciones['__sku_web__'] = String(sku);

    // LOG primer producto completo para verificar estructura
    if (Object.keys(especificaciones).length === 0) {
      console.warn(`[scraper] specs vacías. Muestra de datos API: ${JSON.stringify(productoData).slice(0, 400)}`);
    } else {
      console.log(`[scraper] titulo="${titulo}" specs=${Object.keys(especificaciones).filter(k=>!k.startsWith('__')).length}: ${Object.keys(especificaciones).filter(k=>!k.startsWith('__')).slice(0,5).join(',')}`);
    }

    return { url, titulo, imagen: null, especificaciones };

  } catch (err) {
    return { url, titulo:'', imagen:null, especificaciones:{}, error:`Scraper error: ${err?.message||err}` };
  } finally {
    try { await page.close(); } catch (_) {}
    if (ownsBrowser) { try { await browser.close(); } catch (_) {} }
  }
}

export default scrapeProduct;
