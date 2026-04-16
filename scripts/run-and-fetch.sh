#!/usr/bin/env bash
# scripts/run-and-fetch.sh
#
# Dispara el workflow auditor.yml, espera a que termine y descarga el
# artifact "reporte-auditoria-ia" (Reporte_Auditoria_IA.xlsx).
#
# Requisitos:
#   - gh CLI logueado (gh auth login) con permisos sobre el repo.
#   - jq (opcional; se usa como fallback si esta disponible).
#
# Uso:
#   ./scripts/run-and-fetch.sh                    # usa rama main
#   ./scripts/run-and-fetch.sh claude/mi-branch   # dispara en otra rama
#   ./scripts/run-and-fetch.sh main ./out         # dir de salida custom
#
# Variables de entorno opcionales:
#   REPO      (default: asesoramientotecnico-alt/pdf-auditor-v2)
#   WORKFLOW  (default: auditor.yml)
#   ARTIFACT  (default: reporte-auditoria-ia)

set -euo pipefail

REPO="${REPO:-asesoramientotecnico-alt/pdf-auditor-v2}"
WORKFLOW="${WORKFLOW:-auditor.yml}"
ARTIFACT="${ARTIFACT:-reporte-auditoria-ia}"
BRANCH="${1:-main}"
OUT_DIR="${2:-./reports}"

say() { printf '\033[1;36m[run-and-fetch]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[run-and-fetch]\033[0m %s\n' "$*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || die "gh CLI no esta instalado. Instalalo desde https://cli.github.com/"
gh auth status >/dev/null 2>&1 || die "gh CLI no esta autenticado. Corre: gh auth login"

mkdir -p "$OUT_DIR"

# 1) Momento previo al dispatch: guardamos el ultimo run para detectar el nuevo.
say "Repo=$REPO  Workflow=$WORKFLOW  Branch=$BRANCH"
PREV_ID="$(gh run list -R "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // empty' || true)"
say "Ultimo run previo: ${PREV_ID:-<ninguno>}"

# 2) Disparamos workflow_dispatch.
say "Disparando workflow_dispatch..."
gh workflow run "$WORKFLOW" -R "$REPO" --ref "$BRANCH"

# 3) Esperamos a que aparezca el nuevo run (polling corto).
say "Esperando a que GitHub cree el run..."
NEW_ID=""
for i in $(seq 1 30); do
  NEW_ID="$(gh run list -R "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // empty' || true)"
  if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "$PREV_ID" ]; then
    break
  fi
  sleep 2
done
[ -n "$NEW_ID" ] && [ "$NEW_ID" != "$PREV_ID" ] || die "No se detecto un nuevo run tras 60s. Revisa Actions manualmente."
say "Nuevo run ID: $NEW_ID  ->  https://github.com/$REPO/actions/runs/$NEW_ID"

# 4) Esperamos a que termine (gh run watch hace streaming de logs + exit status).
say "Esperando a que termine (gh run watch)..."
if ! gh run watch "$NEW_ID" -R "$REPO" --exit-status; then
  say "El run termino con fallo. Intento descargar artifacts igual..."
  set +e
  gh run download "$NEW_ID" -R "$REPO" -D "$OUT_DIR"
  set -e
  die "Workflow fallo. Revisa: https://github.com/$REPO/actions/runs/$NEW_ID"
fi

# 5) Descargamos el artifact del reporte.
say "Descargando artifact '$ARTIFACT' en $OUT_DIR ..."
gh run download "$NEW_ID" -R "$REPO" -n "$ARTIFACT" -D "$OUT_DIR"

# gh pone el contenido del artifact directamente en OUT_DIR.
REPORT_PATH="$(find "$OUT_DIR" -maxdepth 2 -name 'Reporte_Auditoria_IA.xlsx' -print -quit || true)"
if [ -n "${REPORT_PATH:-}" ]; then
  say "Reporte listo: $REPORT_PATH"
else
  say "Artifact descargado en $OUT_DIR (no encontre el .xlsx con nombre esperado, revisa)."
fi

say "Run URL: https://github.com/$REPO/actions/runs/$NEW_ID"
