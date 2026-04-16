// scraper.js
// Utiliza Puppeteer para scrapear paginas de producto de famiq.com.ar
// Extrae: imagen principal (src), titulo descriptivo, tabla de especificaciones tecnicas (JSON clave/valor).
// NOTA: famiq.com.ar tiene SSL invalido, por eso corre con NODE_TLS_REJECT_UNAUTHORIZED='0' y
//       se lanza Puppeteer con --ignore-certificate-errors.

import puppeteer from 'puppeteer';

// Forzar aceptacion de certificados invalidos a nivel proceso.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DEFAULT_TIMEOUT_MS = 45000;
const NAV_TIMEOUT_MS = 60000;

/**
 * Lanza un browser de Puppeteer con las flags necesarias para correr en GitHub Actions
 * y para ignorar los certificados SSL invalidos de famiq.com.ar.
 */
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

/**
 * Scrapea una URL de producto de famiq.com.ar.
 *
 * @param {string} url - URL de la ficha de producto (famiq.com.ar/producto/...)
 * @param {import('puppeteer').Browser} [externalBrowser] - Browser reutilizable (opcional).
 * @returns {Promise<{url:string, titulo:string, imagen:string|null, especificaciones:Object<string,string>, error?:string}>}
 */
export async function scrapeProduct(url, externalBrowser = null) {
  let browser = externalBrowser;
  let ownsBrowser = false;
  if (!browser) {
    browser = await launchBrowser();
    ownsBrowser = true;
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Famiq usa WooCommerce. Esperamos el contenedor tipico.
    try {
      await page.waitForSelector('.product, .woocommerce, h1, .product_title', { timeout: 15000 });
    } catch (_) {
      // continuamos igual: puede ser un tema customizado.
    }

    const data = await page.evaluate(() => {
      const textOf = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : '');

      // --- Titulo ---
      const titleSelectors = [
        'h1.product_title',
        'h1.entry-title',
        '.product_title',
        'h1'
      ];
      let titulo = '';
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && textOf(el)) {
          titulo = textOf(el);
          break;
        }
      }

      // --- Imagen principal ---
      const imgSelectors = [
        '.woocommerce-product-gallery__image img',
        '.woocommerce-product-gallery img',
        'figure.wp-post-image',
        'img.wp-post-image',
        '.product img',
        'main img'
      ];
      let imagen = null;
      for (const sel of imgSelectors) {
        const img = document.querySelector(sel);
        if (img) {
          imagen =
            img.getAttribute('data-large_image') ||
            img.getAttribute('data-src') ||
            img.getAttribute('src') ||
            null;
          if (imagen) break;
        }
      }
      if (imagen && imagen.startsWith('//')) imagen = 'https:' + imagen;

      // --- Especificaciones tecnicas (tabla clave/valor) ---
      const especificaciones = {};

      // 1) Tabla de atributos estandar WooCommerce
      document
        .querySelectorAll('table.shop_attributes tr, table.woocommerce-product-attributes tr')
        .forEach((tr) => {
          const k = textOf(tr.querySelector('th, .woocommerce-product-attributes-item__label'));
          const v = textOf(tr.querySelector('td, .woocommerce-product-attributes-item__value'));
          if (k && v) especificaciones[k] = v;
        });

      // 2) Cualquier otra tabla de especificaciones en la pagina
      document.querySelectorAll('table').forEach((table) => {
        table.querySelectorAll('tr').forEach((tr) => {
          const cells = tr.querySelectorAll('th, td');
          if (cells.length >= 2) {
            const k = textOf(cells[0]);
            const v = textOf(cells[1]);
            if (k && v && k.length < 120 && !especificaciones[k]) {
              especificaciones[k] = v;
            }
          }
        });
      });

      // 3) Listas de definiciones
      document.querySelectorAll('dl').forEach((dl) => {
        const dts = dl.querySelectorAll('dt');
        const dds = dl.querySelectorAll('dd');
        for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
          const k = textOf(dts[i]);
          const v = textOf(dds[i]);
          if (k && v && !especificaciones[k]) especificaciones[k] = v;
        }
      });

      // 4) Descripcion larga: util como fallback para el analisis tecnico
      const descripcionEl = document.querySelector(
        '#tab-description, .woocommerce-Tabs-panel--description, .product-description, .entry-content'
      );
      if (descripcionEl) {
        const desc = textOf(descripcionEl).slice(0, 4000);
        if (desc) especificaciones['__descripcion_larga__'] = desc;
      }

      return { titulo, imagen, especificaciones };
    });

    return {
      url,
      titulo: data.titulo || '',
      imagen: data.imagen || null,
      especificaciones: data.especificaciones || {}
    };
  } catch (err) {
    return {
      url,
      titulo: '',
      imagen: null,
      especificaciones: {},
      error: `Scraper error: ${err?.message || err}`
    };
  } finally {
    try {
      await page.close();
    } catch (_) {}
    if (ownsBrowser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

export default scrapeProduct;
