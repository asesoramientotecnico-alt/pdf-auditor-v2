// scraper.js
// famiq.com.ar es una SPA — datos via /producto/{id}/data?nodo=null
// Sin Puppeteer: axios directo a la API JSON

import axios from 'axios';
import https from 'node:https';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://www.famiq.com.ar/',
  'Origin': 'https://www.famiq.com.ar',
};

function extractProductId(url) {
  const m = String(url).match(/\/producto\/(\d+)/);
  return m ? m[1] : null;
}

export async function scrapeProduct(url, _ignoredBrowser = null, urlImagenDirecta = null) {
  const id = extractProductId(url);
  if (!id) {
    return { url, titulo: '', imagen: null, especificaciones: {}, error: 'No se pudo extraer ID de producto de la URL' };
  }

  const apiUrl = `https://www.famiq.com.ar/producto/${id}/data?nodo=null`;
  let productoData = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(apiUrl, {
        timeout: 30000,
        httpsAgent: insecureAgent,
        headers: HEADERS,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      if (res.status === 503) {
        console.warn(`[scraper] 503 intento ${attempt}/3 para ${url}, reintentando en 15s...`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      productoData = res.data;
      break;
    } catch (err) {
      if (attempt < 3) {
        console.warn(`[scraper] timeout intento ${attempt}/3 para ${url}, reintentando...`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        return { url, titulo: '', imagen: null, especificaciones: {}, error: `Scraper error: ${err?.message || err}` };
      }
    }
  }

  if (!productoData) {
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

  console.log(`[scraper] ${url} titulo="${titulo.slice(0, 40)}" specs=${Object.keys(especificaciones).filter(k => !k.startsWith('__')).length} imagen=${imagen ? '✓' : '✗'}`);

  return { url, titulo, imagen, especificaciones };
}

// launchBrowser exportado vacío para no romper imports existentes en index.js
export async function launchBrowser() { return null; }

export default scrapeProduct;
