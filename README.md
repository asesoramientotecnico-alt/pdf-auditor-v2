# Agente Auditor de Calidad Web - Famiq

Robot automatizado que audita las fichas de producto de famiq.com.ar y reporta inconsistencias de imagen, texto y especificaciones técnicas. Usa **Claude Haiku** (Anthropic) como motor de análisis visual y técnico.

## Que hace

1. Lee la planilla de inventario desde **Google Sheets** (`SPREADSHEET_ID`, hoja `Hoja2`).
2. Por cada producto (en paralelo, concurrencia configurable):
   - **Integridad PDF**: descarga el PDF publicado en famiq.com.ar y el PDF maestro de Google Drive, extrae texto con pdfjs-dist, normaliza y compara hash SHA-256. Si los hashes difieren, describe la diferencia (versión, cantidad de páginas, volumen de texto).
   - **Scraping**: llama directamente a la API JSON interna de famiq.com.ar (`/producto/{id}/data?nodo=null`) para obtener título, especificaciones técnicas y descripción del producto.
   - **Auditoría IA**: envía imagen + datos a Claude Haiku, que actúa como Inspector de Oficina Técnica y valida:
     - **Visual**: la imagen corresponde al `texto_comercial` (COHERENTE / ERROR / SIN_IMAGEN).
     - **Técnico**: material, diámetro, norma y conexión coinciden entre `texto_comercial` y la tabla de specs.
     - **Texto web**: el título publicado es coherente con las specs.
     - **Descripción**: la descripción web pertenece a la familia de producto correcta.
3. Genera `Reporte_Auditoria_IA.xlsx` con 21 columnas por SKU.
4. Sube el reporte a **SharePoint/OneDrive** (Microsoft Graph API) con dos versiones: archivo fijo y copia histórica con fecha.

## Modos de ejecucion

| Modo | Variable | Descripcion |
| --- | --- | --- |
| **sync** (default) | `AUDIT_MODE=sync` | 1 llamada a Claude por SKU con throttle de 13 s (5 req/min). Checkpoint en `checkpoint.json` permite retomar si se corta. |
| **batch** | `AUDIT_MODE=batch` | Usa la [Batch API de Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/batch-processing): 50% más barato, procesa todos los SKUs en paralelo y espera hasta 6 horas el resultado. Incluye chunking automático si el batch supera 200 MB o 90 000 requests. |

Ambos modos incluyen:
- **Caché visual en memoria**: si varios SKUs comparten la misma imagen, la evaluación visual se reutiliza y solo se vuelve a llamar a Claude para la parte técnica.
- **Verificación 2-pass**: si el primer análisis devuelve `estado_visual=ERROR`, se hace una segunda llamada con un prompt más conservador antes de confirmar el error.
- **Retry automático**: filas con `ERROR_DESCARGA`, `SIN_IMAGEN` (con URL de imagen presente) o JSON no parseable se reintentan 30 s después de terminar la ronda principal.

## Archivos

| Archivo | Responsabilidad |
| --- | --- |
| `index.js` | Orquestador: lectura de Sheets, caché de PDFs, comparación de hashes, generación del Excel y notificación. |
| `scraper.js` | Extrae datos del producto vía API JSON de famiq.com.ar. No usa Puppeteer. |
| `agent.js` | Modo sync: 1 llamada a Claude por SKU con throttle y caché visual en memoria. |
| `agent-batch.js` | Modo batch: submit + poll + retrieve a la Batch API de Anthropic. Incluye chunking, dedup de imágenes y 2-pass. |
| `agent-common.js` | Prompts del sistema, helpers de imagen (descarga, resize con sharp), parseo JSON y normalización de respuestas. Compartido entre sync y batch. |
| `notifier.js` | Sube el Excel a SharePoint via Microsoft Graph API (ROPC). Guarda archivo fijo `Reporte_Auditoria_IA.xlsx` + copia histórica con fecha. |
| `.github/workflows/auditor.yml` | Workflow manual (`workflow_dispatch`) con selector de modo sync/batch. Runner self-hosted. |

## Variables de entorno / Secrets

| Variable | Descripcion |
| --- | --- |
| `ANTHROPIC_API_KEY` | API key de Anthropic (Claude Haiku). |
| `SPREADSHEET_ID` | ID del Google Sheet con el inventario (default: `1QYT15W8NJ5M2UPVyvBy-QqfnOA4fEbTbbZfy7qrNLrY`). |
| `ONEDRIVE_USER` | Usuario corporativo de Microsoft 365 para subir a SharePoint. |
| `ONEDRIVE_PASS` | Contraseña del usuario anterior. |
| `AUDIT_MODE` | `sync` (default) o `batch`. |
| `CONCURRENCY` | Hilos paralelos de scraping + PDF (default: `8`). |
| `INPUT_SHEET` | Nombre de la hoja (default: `Hoja2`). |
| `OUTPUT_XLSX` | Nombre del archivo de salida (default: `Reporte_Auditoria_IA.xlsx`). |
| `REPORT_RECIPIENT` | Destino legado del reporte (default: `jortiz@famiq.com.ar`). |

**Google Cloud** (CI): autenticación vía Workload Identity Federation.
- `WIF_PROVIDER`: proveedor de identidad de GCP.
- `SA_EMAIL`: cuenta de servicio con acceso a Google Sheets y Google Drive (para PDFs maestros privados).

`NODE_TLS_REJECT_UNAUTHORIZED='0'` se fuerza internamente porque famiq.com.ar presenta un certificado inválido.

## Columnas del reporte

| Columna | Descripcion |
| --- | --- |
| SKU | Código del producto. |
| Texto Comercial | Nombre oficial interno (fuente de verdad). |
| URL Famiq | Link al producto en famiq.com.ar. |
| Estado Visual | `COHERENTE` / `ERROR` / `SIN_IMAGEN` / `ERROR_DESCARGA`. |
| Analisis Visual | Justificación del estado visual. |
| URL Imagen Auditada | URL de la imagen evaluada. |
| Estado Tecnico | `OK` / `ERROR`. |
| Validaciones | Comparación campo a campo (material, diámetro, norma, conexión). |
| Estado Descripcion | `COHERENTE` / `INCOHERENTE` / `SIN_DESCRIPCION`. |
| Analisis Descripcion | Justificación del estado de la descripción. |
| Descripcion Web | Texto de la descripción web (hasta 600 caracteres). |
| Integridad PDF | `OK` / `DESACTUALIZADO` / `SIN_MAESTRO` / `ERROR`. |
| Diferencia PDF | Detalle de la diferencia entre el PDF web y el maestro (versión, páginas, volumen). |
| Version PDF | Versión detectada en el PDF web (ej: `V4.2019`). |
| URL FT Web | URL del PDF publicado. |
| Link FT Drive | URL del PDF maestro en Google Drive. |
| Discrepancias | Lista consolidada de errores (PDF + IA). |
| Recomendaciones | Sugerencias de mejora (specs incompletas, título mal redactado, etc.). |
| Propuesta de Correccion | Texto propuesto por Claude para corregir la ficha. |
| Hash Web | SHA-256 del contenido normalizado del PDF web. |
| Hash Maestro (Drive) | SHA-256 del contenido normalizado del PDF maestro. |

El coloreado es automático: verde para `OK`/`COHERENTE`, amarillo para `DESACTUALIZADO`/`ERROR_DESCARGA`, azul claro para `SIN_IMAGEN`/`SIN_DESCRIPCION`/`SIN_MAESTRO`, rojo para `ERROR`/`INCOHERENTE`.

## Ejecucion local

```bash
npm install
# Credenciales GCP via Application Default Credentials:
#   gcloud auth application-default login
# o exportando la variable:
#   export GOOGLE_APPLICATION_CREDENTIALS=/ruta/credentials.json
export ANTHROPIC_API_KEY=sk-ant-...
export SPREADSHEET_ID=1QYT15W8NJ5M2UPVyvBy-QqfnOA4fEbTbbZfy7qrNLrY
node index.js

# Modo batch (más barato, espera hasta 6 h):
AUDIT_MODE=batch node index.js
```

Si la corrida se corta (modo sync), `checkpoint.json` permite retomar desde la última fila procesada. Las corridas siguientes reutilizan `pdf_hash_cache.json` para no re-hashear PDFs ya procesados.

## GitHub Actions

El workflow `.github/workflows/auditor.yml` se dispara manualmente desde la pestaña **Actions** con un selector de modo (sync / batch). Requiere un runner **self-hosted** con Node 22. Al finalizar:
- Sube `Reporte_Auditoria_IA.xlsx` como artifact (siempre).
- Sube `checkpoint.json` como artifact si el job falla (para diagnóstico).
- Si están configurados `ONEDRIVE_USER` / `ONEDRIVE_PASS`, sube el reporte a SharePoint automáticamente.
