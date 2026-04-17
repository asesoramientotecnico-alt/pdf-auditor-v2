// scraper.js
import puppeteer from 'puppeteer';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NAV_TIMEOUT_MS  = 60000;
const WAIT_TIMEOUT_MS = 25000;

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
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768'
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
    // Headers realistas para evitar detección de bot
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma':  'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
    });

    // Ocultar que es Puppeteer
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.setViewport({ width: 1366, height: 768 });

    // Primera carga con domcontentloaded
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Esperar que aparezca contenido real — h1 o cualquier elemento de producto
    // Si el sitio usa challenge JS (Cloudflare), esperar más tiempo
    let contentLoaded = false;
    for (const selector of [
      'h1',
      '.product_title',
      '.informacion-tecnica',
      '.woocommerce-product-details__short-description',
      'table',
      '.entry-summary',
      '.product'
    ]) {
      try {
        await page.waitForSelector(selector, { timeout: WAIT_TIMEOUT_MS });
        contentLoaded = true;
        break;
      } catch (_) {}
    }

    if (!contentLoaded) {
      // Último recurso: esperar 8 segundos y continuar igual
      await new Promise((r) => setTimeout(r, 8000));
    } else {
      // Pausa adicional para que JS termine de renderizar tablas
      await new Promise((r) => setTimeout(r, 3000));
    }

    const data = await page.evaluate(() => {
      const textOf = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : '');

      // --- Titulo ---
      let titulo = '';
      for (const sel of ['h1.product_title','h1.entry-title','.product_title','h1']) {
        const el = document.querySelector(sel);
        if (el && textOf(el)) { titulo = textOf(el); break; }
      }

      // --- Debug HTML snapshot ---
      const bodySnippet = document.body ? document.body.innerHTML.slice(0, 500) : 'EMPTY';

      // --- Especificaciones ---
      const especificaciones = {};

      document.querySelectorAll('table').forEach((table) => {
        table.querySelectorAll('tr').forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll('th, td'));
          if (cells.length === 2) {
            const k = textOf(cells[0]); const v = textOf(cells[1]);
            if (k && v && k.length < 120) especificaciones[k] = v;
          }
          if (cells.length === 4) {
            const k1 = textOf(cells[0]); const v1 = textOf(cells[1]);
            const k2 = textOf(cells[2]); const v2 = textOf(cells[3]);
            if (k1 && v1 && k1.length < 120) especificaciones[k1] = v1;
            if (k2 && v2 && k2.length < 120) especificaciones[k2] = v2;
          }
          if (cells.length > 4) {
            for (let i = 0; i + 1 < cells.length; i += 2) {
              const k = textOf(cells[i]); const v = textOf(cells[i+1]);
              if (k && v && k.length < 120) especificaciones[k] = v;
            }
          }
        });
      });

      // dl/dt/dd
      document.querySelectorAll('dl').forEach((dl) => {
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
          const k = textOf(dts[i]); const v = textOf(dds[i]);
          if (k && v && !especificaciones[k]) especificaciones[k] = v;
        }
      });

      // Descripcion larga
      const descEl = document.querySelector(
        '#tab-description, .woocommerce-Tabs-panel--description, .product-description, .entry-content, .woocommerce-product-details__short-description'
      );
      if (descEl) {
        const desc = textOf(descEl).slice(0, 4000);
        if (desc) especificaciones['__descripcion_larga__'] = desc;
      }

      const skuEl = document.querySelector('.sku, [itemprop="sku"]');
      if (skuEl) especificaciones['__sku_web__'] = textOf(skuEl);

      return { titulo, especificaciones, bodySnippet };
    });

    console.log(`[scraper] ${url} titulo="${data.titulo}" specs=${Object.keys(data.especificaciones).filter(k=>!k.startsWith('__')).length} keys`);
    if (!data.titulo && Object.keys(data.especificaciones).length === 0) {
      console.warn(`[scraper] WARN: pagina vacia. HTML snippet: ${data.bodySnippet.replace(/\n/g,' ').slice(0,200)}`);
    }

    return {
      url,
      titulo:           data.titulo || '',
      imagen:           null,
      especificaciones: data.especificaciones || {}
    };

  } catch (err) {
    return {
      url, titulo: '', imagen: null, especificaciones: {},
      error: `Scraper error: ${err?.message || err}`
    };
  } finally {
    try { await page.close(); } catch (_) {}
    if (ownsBrowser) { try { await browser.close(); } catch (_) {} }
  }
}

export default scrapeProduct;
