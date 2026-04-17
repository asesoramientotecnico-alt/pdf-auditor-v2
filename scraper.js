// scraper.js
import puppeteer from 'puppeteer';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const NAV_TIMEOUT_MS = 60000;
const WAIT_TIMEOUT_MS = 20000;

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
      '--single-process'
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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    );

    // networkidle2 espera que el JS termine de renderizar
    await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });

    // Esperar específicamente la tabla de información técnica de famiq
    // o cualquier h1 como fallback
    try {
      await page.waitForSelector(
        'table, .informacion-tecnica, .product-attributes, h1, .product_title',
        { timeout: WAIT_TIMEOUT_MS }
      );
    } catch (_) {}

    // Pequeña pausa adicional para asegurar render completo de tablas JS
    await new Promise((r) => setTimeout(r, 2000));

    const data = await page.evaluate(() => {
      const textOf = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : '');

      // --- Titulo ---
      const titleSelectors = [
        'h1.product_title', 'h1.entry-title', '.product_title', 'h1'
      ];
      let titulo = '';
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && textOf(el)) { titulo = textOf(el); break; }
      }

      // --- Especificaciones tecnicas ---
      // famiq.com.ar usa tablas con 4 columnas: label | valor | label | valor
      const especificaciones = {};

      document.querySelectorAll('table').forEach((table) => {
        table.querySelectorAll('tr').forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll('th, td'));

          // Caso 1: tabla de 2 columnas (label | valor)
          if (cells.length === 2) {
            const k = textOf(cells[0]);
            const v = textOf(cells[1]);
            if (k && v && k.length < 120) especificaciones[k] = v;
          }

          // Caso 2: tabla de 4 columnas (label | valor | label | valor)
          // que es el formato de famiq.com.ar en "Información técnica"
          if (cells.length === 4) {
            const k1 = textOf(cells[0]);
            const v1 = textOf(cells[1]);
            const k2 = textOf(cells[2]);
            const v2 = textOf(cells[3]);
            if (k1 && v1 && k1.length < 120) especificaciones[k1] = v1;
            if (k2 && v2 && k2.length < 120) especificaciones[k2] = v2;
          }

          // Caso 3: más columnas, procesar pares
          if (cells.length > 4 && cells.length % 2 === 0) {
            for (let i = 0; i < cells.length; i += 2) {
              const k = textOf(cells[i]);
              const v = textOf(cells[i + 1]);
              if (k && v && k.length < 120) especificaciones[k] = v;
            }
          }
        });
      });

      // Listas de definiciones (dl/dt/dd)
      document.querySelectorAll('dl').forEach((dl) => {
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
          const k = textOf(dts[i]);
          const v = textOf(dds[i]);
          if (k && v && !especificaciones[k]) especificaciones[k] = v;
        }
      });

      // Descripcion larga
      const descripcionEl = document.querySelector(
        '#tab-description, .woocommerce-Tabs-panel--description, .product-description, .entry-content, .woocommerce-product-details__short-description'
      );
      if (descripcionEl) {
        const desc = textOf(descripcionEl).slice(0, 4000);
        if (desc) especificaciones['__descripcion_larga__'] = desc;
      }

      // SKU publicado (para detectar discrepancias)
      const skuEl = document.querySelector('.sku, [itemprop="sku"]');
      if (skuEl) especificaciones['__sku_web__'] = textOf(skuEl);

      return { titulo, especificaciones };
    });

    return {
      url,
      titulo:           data.titulo || '',
      imagen:           null,  // imagen deshabilitada
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
