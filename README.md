# Raspcontrol v3 — Industrial IoT Edge Controller

Controlador de hardware y pasarela IoT (Edge Gateway) para **Raspberry Pi**, diseñado para la automatización, monitoreo energético y control climático en entornos industriales y comerciales.

---

## 🚀 Características Principales

- **Conectividad en Tiempo Real (WebSocket):** Comunicación bidireccional continua con el servidor central mediante WebSockets, con reconexión automática y algoritmo de retroceso exponencial (*exponential backoff*).
- **Operación Local Resiliente (100% Offline):** Guarda el manifiesto de dispositivos, estados y horarios en una base de datos local JSON (`db_store_v3.json`). La Raspberry Pi continúa operando sus cronogramas y lógica de control incluso si se pierde la conexión a internet.
- **Control de Clima Inteligente (HVAC):**
  - Manejo de compresor y ventilador.
  - Algoritmo de histéresis térmica configurable.
  - Protección de ciclo corto (*short-cycle protection*) para prolongar la vida útil de los compresores.
- **Monitoreo de Energía Modbus RTU / RS485:** Lectura periódica y estructurada de medidores de energía multifásicos Honeywell.
- **Sensores de Temperatura 1-Wire (DS18B20):** Lectura multi-muestreo con filtrado de ruido y rechazo de lecturas espurias.
- **Modos de Operación:**
  - `NATIVE`: Acceso directo al hardware real de la Raspberry Pi (GPIO, 1-Wire, Serial RS485).
  - `MOCK`: Modo de simulación completo para pruebas y desarrollo en cualquier PC o laptop.

---

## 📋 Requisitos del Sistema (Raspberry Pi)

1. **Hardware:**
   - Raspberry Pi 3B+, 4B, 5 o Compute Module 4.
   - Adaptador USB a RS485 (para medidores Modbus) o HAT RS485.
   - Sensores DS18B20 con resistencia pull-up de 4.7kΩ (en GPIO 4 / Pin 7).
2. **Software:**
   - Raspberry Pi OS (64-bit o 32-bit recomendado).
   - **Node.js:** Versión `>= 18.x` (LTS recomendada).
   - **NPM:** `>= 9.x`.
   - **PM2:** Para gestión de procesos y autoarranque.

---

## 🛠️ Instalación Rápida

### 1. Clonar el repositorio en la Raspberry Pi
```bash
git clone https://github.com/TU_USUARIO/raspcontrol-v3.git
cd raspcontrol-v3
```

### 2. Instalar dependencias del sistema y de Node.js
```bash
# Dependencias necesarias para compilar librerías nativas (onoff, serialport, i2c)
sudo apt update && sudo apt install -y build-essential python3

# Instalar dependencias de Node
npm install
```

### 3. Configurar variables de entorno
Copia la plantilla de configuración y edita las variables:
```bash
cp .env.example .env
nano .env
```

Define tu `GATEWAY_ID`, `GATEWAY_TOKEN` y la URL del WebSocket de tu servidor central:
```env
GATEWAY_ID=gateway-planta-01
GATEWAY_TOKEN=clave-secreta-asignada
SERVER_WS_URL=wss://app.tudominio.com/api/device/control
HARDWARE_MODE=NATIVE
TIMEZONE=America/Mexico_City
LOG_LEVEL=info
```

---

## ⚡ Habilitar Interfaces de Hardware (Solo Raspberry Pi)

### 1-Wire (Sensores de Temperatura DS18B20):
Asegúrate de tener habilitada la interfaz 1-Wire:
```bash
sudo raspi-config
# Interface Options -> 1-Wire -> Enable
```
O agregando la siguiente línea en `/boot/firmware/config.txt` (o `/boot/config.txt`):
```ini
dtoverlay=w1-gpio
```
Reinicia la Raspberry Pi:
```bash
sudo reboot
```

---

## 🚦 Ejecución y Gestión con PM2 (Producción)

Se recomienda utilizar **PM2** para que el servicio se ejecute en segundo plano y se reinicie automáticamente ante fallos o reinicios de la Raspberry Pi:

```bash
# Instalar PM2 globalmente (si no lo tienes)
sudo npm install -g pm2

# Iniciar el controlador con la configuración optimizada
npm run pm2:start

# Ver logs en tiempo real
npm run pm2:logs

# Configurar autoarranque al encender el sistema
pm2 save
pm2 startup
# (Copia y ejecuta el comando sudo que PM2 te indique en pantalla)
```

### Comandos útiles de PM2:
- `npm run pm2:restart` — Reiniciar el servicio.
- `npm run pm2:stop` — Detener el servicio.
- `pm2 status` — Ver estado y consumo de memoria/CPU.

---

## 📂 Estructura del Código

```text
raspcontrol-v3/
├── .env.example          # Plantilla de variables de entorno
├── .gitignore            # Archivos ignorados por Git
├── ecosystem.config.cjs  # Configuración de PM2 para producción
├── package.json          # Metadatos y scripts del proyecto
├── index.js              # Punto de entrada principal y bucles de control
├── config.js             # Gestor de configuración y variables de entorno
├── websocket.js          # Cliente WebSocket resiliente con backoff
├── controller.js         # Lógica de despacho de comandos y automatización
├── hardware.js           # Capa de abstracción de hardware (GPIO / 1-Wire / MOCK)
├── energy_meters.js      # Driver y recolector de métricas Modbus RTU
├── modbus_honeywell.js   # Mapeo de registros de medidores Honeywell
├── db.js                 # Manejador de persistencia JSON local resiliente
└── logger.js             # Módulo de registro de eventos con colores y marcas de tiempo
```

---

## 🔒 Licencia y Seguridad
Este proyecto está bajo la Licencia MIT.
**Nota de Seguridad:** Nunca agregues ni compartas tus archivos `.env` o tokens de producción en repositorios públicos.
