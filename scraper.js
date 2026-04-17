// scraper.js
// famiq.com.ar es una SPA — el contenido se carga via API interna.
// Estrategia: interceptar requests XHR/fetch para capturar la respuesta
// de la API de producto, en lugar de parsear el DOM.

import puppeteer from 'puppeteer';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NAV_TIMEOUT_MS = 60000;

export async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}

export async function scrapeProduct(url, externalBrowser = null) {
  let browser = externalBrowser;
  let ownsBrowser = false;
  if (!browser) {
    browser = await launchBrowser();
    ownsBrowser = true;
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    await page.setViewport({ width: 1366, height: 768 });

    // Interceptar respuestas de la API interna
    const apiResponses = [];
    page.on('response', async (response) => {
      const respUrl = response.url();
      const status  = response.status();
      // Capturar cualquier llamada JSON que parezca ser de producto
      if (
        status === 200 &&
        (respUrl.includes('/api/') || respUrl.includes('/producto') ||
         respUrl.includes('producto') || respUrl.includes('product')) &&
        !respUrl.includes('.js') && !respUrl.includes('.css')
      ) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const json = await response.json();
            apiResponses.push({ url: respUrl, data: json });
          }
        } catch (_) {}
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Esperar que el JS haga sus llamadas a la API
    await new Promise((r) => setTimeout(r, 6000));

    // Intentar esperar que aparezca contenido en el DOM
    try {
      await page.waitForFunction(
        () => {
          const h1 = document.querySelector('h1');
          return h1 && h1.textContent.trim().length > 3;
        },
        { timeout: 15000 }
      );
    } catch (_) {}

    // Pausa extra
    await new Promise((r) => setTimeout(r, 2000));

    // Extraer desde el DOM (intent principal)
    const domData = await page.evaluate(() => {
      const textOf = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : '');

      let titulo = '';
      for (const sel of ['h1.product_title','h1.entry-title','.product_title','h1']) {
        const el = document.querySelector(sel);
        if (el && textOf(el)) { titulo = textOf(el); break; }
      }

      const especificaciones = {};

      document.querySelectorAll('table').forEach((table) => {
        table.querySelectorAll('tr').forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll('th, td'));
          if (cells.length === 2) {
            const k = textOf(cells[0]); const v = textOf(cells[1]);
            if (k && v && k.length < 120) especificaciones[k] = v;
          }
          if (cells.length === 4) {
            const k1=textOf(cells[0]),v1=textOf(cells[1]),k2=textOf(cells[2]),v2=textOf(cells[3]);
            if (k1&&v1&&k1.length<120) especificaciones[k1]=v1;
            if (k2&&v2&&k2.length<120) especificaciones[k2]=v2;
          }
          if (cells.length > 4) {
            for (let i=0;i+1<cells.length;i+=2) {
              const k=textOf(cells[i]),v=textOf(cells[i+1]);
              if (k&&v&&k.length<120) especificaciones[k]=v;
            }
          }
        });
      });

      document.querySelectorAll('dl').forEach((dl) => {
        const dts=dl.querySelectorAll('dt'), dds=dl.querySelectorAll('dd');
        for (let i=0;i<Math.min(dts.length,dds.length);i++) {
          const k=textOf(dts[i]),v=textOf(dds[i]);
          if (k&&v&&!especificaciones[k]) especificaciones[k]=v;
        }
      });

      const descEl = document.querySelector(
        '#tab-description,.woocommerce-Tabs-panel--description,.product-description,.entry-content,.woocommerce-product-details__short-description'
      );
      if (descEl) {
        const desc = textOf(descEl).slice(0,4000);
        if (desc) especificaciones['__descripcion_larga__'] = desc;
      }

      const skuEl = document.querySelector('.sku,[itemprop="sku"]');
      if (skuEl) especificaciones['__sku_web__'] = textOf(skuEl);

      // Capturar todo el texto visible como fallback
      const bodyText = document.body ? document.body.innerText.slice(0, 3000) : '';

      return { titulo, especificaciones, bodyText };
    });

    // Si el DOM está vacío, intentar parsear desde respuestas de API interceptadas
    let titulo       = domData.titulo;
    let especificaciones = domData.especificaciones;

    console.log(`[scraper] ${url} DOM: titulo="${titulo}" specs=${Object.keys(especificaciones).filter(k=>!k.startsWith('__')).length} apiResponses=${apiResponses.length}`);

    // Log de API responses para debug
    if (apiResponses.length > 0) {
      apiResponses.forEach(r => {
        console.log(`  [api] ${r.url.slice(0,100)} keys=${Object.keys(r.data).slice(0,8).join(',')}`);
      });
    }

    // Si DOM vacío pero hay texto visible, usarlo como descripción
    if (!titulo && domData.bodyText && domData.bodyText.length > 50) {
      const lines = domData.bodyText.split('\n').map(l=>l.trim()).filter(l=>l.length>3);
      titulo = lines[0] || '';
      if (lines.length > 1) especificaciones['__descripcion_larga__'] = lines.slice(0,30).join(' | ');
      console.log(`[scraper] fallback texto visible: "${titulo.slice(0,80)}"`);
    }

    // Si hay respuestas de API, extraer campos del producto
    if ((!titulo || Object.keys(especificaciones).length === 0) && apiResponses.length > 0) {
      for (const resp of apiResponses) {
        const d = resp.data;
        // Intentar campos comunes de APIs de productos
        if (d.nombre || d.name || d.titulo || d.title) {
          titulo = d.nombre || d.name || d.titulo || d.title || titulo;
        }
        if (d.especificaciones || d.attributes || d.specs) {
          const specs = d.especificaciones || d.attributes || d.specs;
          if (typeof specs === 'object') Object.assign(especificaciones, specs);
        }
        if (d.descripcion || d.description) {
          especificaciones['__descripcion_larga__'] = String(d.descripcion || d.description).slice(0,4000);
        }
      }
      console.log(`[scraper] API fallback: titulo="${titulo}" specs=${Object.keys(especificaciones).filter(k=>!k.startsWith('__')).length}`);
    }

    return { url, titulo: titulo||'', imagen: null, especificaciones };

  } catch (err) {
    return { url, titulo:'', imagen:null, especificaciones:{}, error:`Scraper error: ${err?.message||err}` };
  } finally {
    try { await page.close(); } catch (_) {}
    if (ownsBrowser) { try { await browser.close(); } catch (_) {} }
  }
}

export default scrapeProduct;
