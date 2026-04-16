# Agente Auditor de Calidad Web - Famiq

Robot automatico que audita las fichas tecnicas de famiq.com.ar y reporta inconsistencias.

## Que hace

1. Lee `prueba_robot_FT_2.xlsx` (hoja `Hoja2`).
2. Por cada producto:
   - Descarga el PDF publicado en famiq.com.ar (columna 9) y el PDF maestro de Google Drive (columna 11), calcula SHA-256 y compara.
   - Scrapea la URL del producto (columna 6) con Puppeteer y extrae imagen principal, titulo y tabla de especificaciones.
   - Envia los datos a Gemini 1.5 Flash (`agent.js`), que actua como Inspector de Oficina Tecnica y valida **coherencia visual** (imagen vs texto) y **consistencia numerica** (medidas/normas vs descripcion).
3. Genera `Reporte_Auditoria_IA.xlsx` con SKU, descripcion, URL Famiq, resultado integridad PDF, hashes, estado visual, analisis de imagen, estado tecnico, discrepancias y propuesta de correccion.
4. Sube el reporte a Google Drive (carpeta `Reportes PDF Auditor`) y lo manda por mail a `jortiz@famiq.com.ar`.

## Archivos

| Archivo | Responsabilidad |
| --- | --- |
| `scraper.js` | Scraping con Puppeteer (headless, ignora SSL invalido de famiq). |
| `agent.js` | Inspector IA con Gemini 1.5 Flash. Retorna JSON estricto. |
| `notifier.js` | Sube el Excel a Drive y manda mail con adjunto. |
| `index.js` | Orquestador: lectura del Excel, concurrencia 5 con `p-limit`, checkpoint, reporte final. |
| `.github/workflows/auditor.yml` | Cron semanal (lunes 06:00 AR) + workflow_dispatch. |

## Variables de entorno / Secrets

- `GEMINI_API_KEY` - API key de Google AI Studio (Gemini).
- `GOOGLE_CREDENTIALS_JSON` - contenido del JSON de la cuenta de servicio `pdf-auditor-bot@pdf-auditor.iam.gserviceaccount.com`.
- `REPORT_RECIPIENT` (opcional) - default `jortiz@famiq.com.ar`.
- `INPUT_XLSX`, `INPUT_SHEET`, `OUTPUT_XLSX` (opcionales) - overrides.
- `GMAIL_IMPERSONATE` (opcional) - usuario real del dominio a impersonar si hay domain-wide delegation para enviar mail via Gmail API.

`NODE_TLS_REJECT_UNAUTHORIZED='0'` se fuerza internamente porque famiq.com.ar presenta un certificado invalido.

## Ejecucion local

```bash
npm install
# dejar credentials.json y prueba_robot_FT_2.xlsx en la raiz
export GEMINI_API_KEY=...
node index.js
```

Si la corrida se corta, `checkpoint.json` permite retomar desde la ultima fila procesada.

## Disparar el workflow y bajar el reporte

Script helper en `scripts/run-and-fetch.sh` que usa `gh` CLI para:
1. Disparar `auditor.yml` via `workflow_dispatch`.
2. Esperar a que el run termine (con streaming de logs).
3. Descargar el artifact `reporte-auditoria-ia` a `./reports`.

```bash
# Prerrequisito: gh CLI logueado con acceso al repo.
gh auth login

# Dispara en main y descarga a ./reports
npm run remote:run

# O especificando rama / carpeta destino:
./scripts/run-and-fetch.sh claude/build-pdf-auditor-agent-FRFqW ./out
```

## Reporte

`Reporte_Auditoria_IA.xlsx` - una fila por SKU con las columnas solicitadas. Filas con estado `OK`/`COHERENTE` se pintan en verde; las que estan en `ERROR` o `DESACTUALIZADO`, en rojo.
