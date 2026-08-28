#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Raspcontrol-v3 — Script de Inicio Rápido
# ==============================================================================

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "${SCRIPT_DIR}"

mkdir -p "${SCRIPT_DIR}/logs"

MODE="${1:-start}"

case "${MODE}" in
  pm2|bg|background)
    if command -v pm2 >/dev/null 2>&1; then
      echo "Iniciando raspcontrol-v3 con PM2..."
      pm2 start ecosystem.config.cjs
      pm2 logs raspcontrol-v3
    elif command -v npm >/dev/null 2>&1; then
      npm run pm2:start
    else
      echo "PM2 y NPM no están disponibles. Ejecutando con Node directamente..."
      node index.js
    fi
    ;;
  dev)
    if command -v npm >/dev/null 2>&1; then
      npm run dev
    else
      node index.js
    fi
    ;;
  *)
    if command -v npm >/dev/null 2>&1; then
      npm start
    else
      echo "NPM no encontrado. Ejecutando directamente con Node.js..."
      node index.js
    fi
    ;;
esac
