import config from './config.js';
import logger from './logger.js';
import db from './db.js';
import wsClient from './websocket.js';
import controller from './controller.js';
import hardware from './hardware.js';
import { readAllMeters } from './energy_meters.js';

let controlInterval = null;
let telemetryInterval = null;
let energyInterval = null;
let manifestInterval = null;

async function runEnergyLoop() {
  try {
    const devices = db.getDevices();
    const results = await readAllMeters(devices);
    
    for (const record of results) {
      wsClient.uploadEnergyTelemetry(record);
    }
  } catch (error) {
    logger.error('Error en el ciclo de lectura de medidores de energía.', error, 'SYS');
  }
}

async function start() {
  logger.success('====================================================', 'SYS');
  logger.success(`Iniciando Cliente de Gateway Raspcontrol-v3 (ID: ${config.GATEWAY_ID})`, 'SYS');
  logger.success(`[DIAGNÓSTICO] HARDWARE_MODE configurado: ${config.HARDWARE_MODE}`, 'SYS');
  logger.success(`[DIAGNÓSTICO] ¿El sistema está corriendo simulado (MOCK)?: ${hardware.isMockHardware}`, 'SYS');
  logger.success('====================================================', 'SYS');

  try {
    // 1. Initialize offline database cache
    db.init();

    // 2. Setup WebSocket command routing to controller
    wsClient.onDeviceCommand((deviceId, state) => {
      controller.handleCommand(deviceId, state);
    });

    // 3. Connect to Next.js WebApp WebSocket
    wsClient.connect();

    // 4. Run initial control loop tick immediately on start
    await controller.run();

    // 5. Start recurring interval task loops
    logger.info(`Iniciando tareas de intervalo del lazo de control: ejecutándose cada ${config.CONTROL_LOOP_INTERVAL_MS / 1000}s.`, 'SYS');
    controlInterval = setInterval(() => {
      controller.run();
    }, config.CONTROL_LOOP_INTERVAL_MS);

    logger.info(`Iniciando tareas de intervalo de carga de telemetría: ejecutándose cada ${config.TELEMETRY_INTERVAL_MS / 1000}s.`, 'SYS');
    telemetryInterval = setInterval(() => {
      controller.reportTelemetry();
    }, config.TELEMETRY_INTERVAL_MS);

    logger.info(`Iniciando tareas de intervalo de lectura de energía: ejecutándose cada ${config.ENERGY_INTERVAL_MS / 1000}s.`, 'SYS');
    energyInterval = setInterval(() => {
      runEnergyLoop();
    }, config.ENERGY_INTERVAL_MS);

    logger.info(`Iniciando tareas de sincronización de manifiesto: ejecutándose cada ${config.MANIFEST_SYNC_INTERVAL_MS / 1000}s.`, 'SYS');
    manifestInterval = setInterval(() => {
      wsClient.requestManifest();
    }, config.MANIFEST_SYNC_INTERVAL_MS);

    // Initial telemetry report after connection established (approx delay)
    setTimeout(() => {
      controller.reportTelemetry();
    }, 5000);

    // Initial energy report after connection established (approx delay)
    setTimeout(() => {
      runEnergyLoop();
    }, 10000);

  } catch (error) {
    logger.error('CRÍTICO: Fallo durante el proceso de inicialización.', error, 'SYS');
    shutdown(1);
  }
}

function shutdown(exitCode = 0) {
  logger.warn(`Se recibió señal de apagado. Limpiando pines de hardware y saliendo (Código: ${exitCode})...`, 'SYS');
  
  if (controlInterval) clearInterval(controlInterval);
  if (telemetryInterval) clearInterval(telemetryInterval);
  if (energyInterval) clearInterval(energyInterval);
  if (manifestInterval) clearInterval(manifestInterval);
  
  // Clean up pins and ensure all relays (fan + compressor) are safely opened/de-energized
  try {
    const devices = db.getDevices();
    devices.forEach(dev => {
      if (dev.pin != null) {
        try {
          const relay = new hardware.GpioRelay(dev.pin, dev.device_id, !dev.active_high);
          relay.write(1); // 1 = APAGADO
          relay.release();
        } catch {}
      }
      if (dev.compressorPin != null) {
        try {
          const compRelay = new hardware.GpioRelay(dev.compressorPin, dev.device_id, !dev.active_high);
          compRelay.write(1); // 1 = APAGADO
          compRelay.release();
        } catch {}
      }
    });

    hardware.releaseAll();
    db.flushLogs();
  } catch (err) {
    logger.error('Ocurrió un error al liberar los recursos de hardware', err, 'SYS');
  }

  logger.success('Apagado completo. ¡Adiós!', 'SYS');
  process.exit(exitCode);
}

// Bind OS exit signals for graceful termination
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Catch unhandled promises and exceptions
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Rechazo de promesa no controlado detectado.', reason, 'SYS');
});

process.on('uncaughtException', (error) => {
  logger.error('¡Ocurrió una excepción no controlada!', error, 'SYS');
  shutdown(1);
});

// Launch Gateway
start();
