#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Raspcontrol-v3 — Script de Configuración e Inicialización Automatizada
# ==============================================================================

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "${SCRIPT_DIR}"

function log() {
  printf '[raspcontrol-v3] %s\n' "$*"
}

log "================================================================="
log " Instalación y Diagnóstico de Raspcontrol v3"
log "================================================================="

# 1. Verificar Node.js
if ! command -v node >/dev/null 2>&1; then
  log "❌ Node.js NO está instalado."
  log "   Para instalar Node.js LTS en Raspberry Pi ejecuta:"
  log "   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -"
  log "   sudo apt-get install -y nodejs"
  exit 1
fi
log "✅ Node.js detectado: $(node --version)"

# 2. Verificar NPM
if ! command -v npm >/dev/null 2>&1; then
  log "❌ NPM NO está reconocido o no se encuentra en el PATH."
  log "   Solución rápida:"
  log "   sudo apt-get update && sudo apt-get install -y npm"
  log "   O reejecuta el aprovisionamiento general: sudo ../first-run/first-run.sh update"
  exit 1
fi
log "✅ NPM detectado: v$(npm --version)"

# 3. Crear directorio de logs
mkdir -p "${SCRIPT_DIR}/logs"

# 4. Asegurar archivo .env
if [[ ! -f "${SCRIPT_DIR}/.env" ]]; then
  if [[ -f "${SCRIPT_DIR}/.env.example" ]]; then
    log "Creando archivo .env a partir de .env.example..."
    cp "${SCRIPT_DIR}/.env.example" "${SCRIPT_DIR}/.env"
    log "⚠️  Se ha creado el archivo .env. Recuerda configurar tu GATEWAY_ID, GATEWAY_TOKEN y SERVER_WS_URL."
  fi
else
  log "✅ Archivo .env configurado."
fi

# 5. Instalar dependencias de Node.js
if [[ ! -d "${SCRIPT_DIR}/node_modules" || "${1:-}" == "--install" || "${1:-}" == "-i" ]]; then
  log "Instalando dependencias de producción y desarrollo..."
  npm install
  log "✅ Dependencias instaladas correctamente."
else
  log "✅ Directorio node_modules ya existente (usa ./setup.sh --install para reinstalar)."
fi

# 6. Verificar PM2
if command -v pm2 >/dev/null 2>&1; then
  log "✅ PM2 detectado: v$(pm2 --version 2>/dev/null || echo 'OK')"
else
  log "⚠️ PM2 no está instalado globalmente."
  log "   Para instalarlo y permitir ejecución como servicio en segundo plano:"
  log "   sudo npm install -g pm2"
fi

echo ""
log "================================================================="
log " Configuración completada."
log " Comandos de ejecución:"
log "   • Probar en consola:       npm start"
log "   • Modo desarrollo:         npm run dev"
log "   • En segundo plano (PM2):  npm run pm2:start"
log "   • Ver logs de PM2:         npm run pm2:logs"
log "================================================================="
