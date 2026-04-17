// scraper.js
// famiq.com.ar es una SPA — datos via /producto/{id}/data?nodo=null
// Imagen: URL directa de la API (imagenes[])

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

export async function scrapeProduct(url, externalBrowser = null, urlImagenDirecta = null) {
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
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });
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
          if (ct.includes('json')) productoData = await response.json();
        } catch (_) {}
      }
    });

    // Delay aleatorio para no parecer bot
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

    let navOk = false;
    for (let navAttempt = 1; navAttempt <= 3; navAttempt++) {
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        if (response && response.status() === 503) {
          console.warn(`[scraper] 503 intento ${navAttempt}/3 para ${url}, reintentando en 15s...`);
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }
        navOk = true;
        break;
      } catch (err) {
        if (navAttempt < 3) {
          console.warn(`[scraper] timeout intento ${navAttempt}/3 para ${url}, reintentando...`);
          await new Promise(r => setTimeout(r, 10000));
        } else {
          throw err;
        }
      }
    }
    if (!navOk) return { url, titulo: '', imagen: null, especificaciones: {}, error: 'Servidor 503 tras 3 intentos' };

    const waitStart = Date.now();
    while (!productoData && Date.now() - waitStart < 15000) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!productoData) {
      console.warn(`[scraper] No se recibió /data para ${url}`);
      return { url, titulo: '', imagen: null, especificaciones: {}, error: 'API /data no respondió' };
    }

    // Titulo
    const titulo = productoData.nombre || productoData.titulo || productoData.descripcion_corta || '';

    // Especificaciones técnicas
    const especificaciones = {};
    const caract = productoData.caracteristicas;
    if (Array.isArray(caract)) {
      caract.forEach((item) => {
        const k = item.nombre || item.label || item.key || item.titulo || '';
        const v = item.valor || item.value || item.descripcion || '';
        if (k && v) especificaciones[k] = String(v);
      });
    } else if (caract && typeof caract === 'object') {
      Object.entries(caract).forEach(([k, v]) => {
        if (k && v) especificaciones[k] = String(v);
      });
    }

    // Descripcion larga
    const desc = productoData.descripcion_larga || productoData.descripcion || productoData.texto || '';
    if (desc) especificaciones['__descripcion_larga__'] = String(desc).slice(0, 4000);

    // SKU web
    const sku = productoData.codigo || productoData.sku || '';
    if (sku) especificaciones['__sku_web__'] = String(sku);

    // Imagen: PRIORIDAD a URL directa de col M
    let imagen = null;
    if (urlImagenDirecta && String(urlImagenDirecta).trim()) {
      imagen = String(urlImagenDirecta).trim();
      console.log(`[scraper] ✓ Col M`);
    } else {
      // Fallback: construir desde imagenes[] de la API
      const imgs = productoData.imagenes || productoData.imagen || [];
      const imgArray = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []);
      if (imgArray.length > 0) {
        const first = imgArray[0];
        let nombre = null;
        if (typeof first === 'string') {
          nombre = first;
        } else if (first?.url) {
          nombre = first.url;
        } else if (first?.nombre) {
          nombre = first.nombre;
        } else if (first?.name) {
          nombre = first.name;
        }
        if (nombre) {
          if (!nombre.startsWith('http')) {
            imagen = `https://www.famiq.com.ar/uploads/materiales/chica/${nombre}`;
          } else {
            imagen = nombre;
          }
          console.log(`[scraper] ✓ API`);
        }
      }
    }

    console.log(`[scraper] ${url} titulo="${titulo.slice(0,40)}" specs=${Object.keys(especificaciones).filter(k=>!k.startsWith('__')).length} imagen=${imagen ? '✓' : '✗'}`);

    return { url, titulo, imagen, especificaciones };

  } catch (err) {
    return { url, titulo: '', imagen: null, especificaciones: {}, error: `Scraper error: ${err?.message || err}` };
  } finally {
    try { await page.close(); } catch (_) {}
    if (ownsBrowser) { try { await browser.close(); } catch (_) {} }
  }
}

export default scrapeProduct;


