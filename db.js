import fs from 'fs';
import path from 'path';
import moment from 'moment-timezone';
import config from './config.js';
import logger from './logger.js';
import hardware from './hardware.js';

let dataStore = {
  manifest: {
    gatewayId: config.GATEWAY_ID,
    devices: []
  },
  deviceStates: {},
  schedules: [],
  offlineTelemetry: []
};

// In-memory buffer for device logs to protect SD card NAND flash from continuous wear
const logBuffer = [];
let logFlushTimer = null;
const LOG_FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFERED_LOGS = 50;

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    db.flushLogs();
  }, LOG_FLUSH_INTERVAL_MS);
}

// In-memory buffer for offline telemetry saves to prevent continuous SD card writes
let telemetrySaveTimer = null;
const TELEMETRY_FLUSH_INTERVAL_MS = 60000; // Batch save to disk every 60s
const MAX_UNSAVED_TELEMETRY = 20;
let unsavedTelemetryCount = 0;

function scheduleTelemetrySave() {
  if (telemetrySaveTimer) return;
  telemetrySaveTimer = setTimeout(() => {
    telemetrySaveTimer = null;
    unsavedTelemetryCount = 0;
    db.save();
  }, TELEMETRY_FLUSH_INTERVAL_MS);
}

export const db = {
  /**
   * Initializes the JSON database, loading it from disk if it exists.
   */
  init: () => {
    try {
      if (fs.existsSync(config.JSON_DB_PATH)) {
        const fileContent = fs.readFileSync(config.JSON_DB_PATH, 'utf-8');
        const parsed = JSON.parse(fileContent);
        
        // Ensure proper schema structure on load
        dataStore = {
          manifest: parsed.manifest || { gatewayId: config.GATEWAY_ID, devices: [] },
          deviceStates: parsed.deviceStates || {},
          schedules: parsed.schedules || [],
          offlineTelemetry: parsed.offlineTelemetry || []
        };
        logger.info(`Base de datos cargada con éxito: ${dataStore.manifest.devices.length} dispositivos mapeados en el manifiesto.`, 'DB');
      } else {
        logger.warn(`No se encontró el archivo de base de datos en ${config.JSON_DB_PATH}. Creando una base de datos nueva limpia.`, 'DB');
        db.save();
      }
    } catch (error) {
      logger.error('Fallo al inicializar la base de datos, restableciendo al esquema predeterminado.', error, 'DB');
      db.save();
    }
  },

  /**
   * Safely and atomically writes the current dataStore to disk.
   */
  save: () => {
    const tempPath = `${config.JSON_DB_PATH}.tmp`;
    try {
      const dataStr = JSON.stringify(dataStore, null, 2);
      fs.writeFileSync(tempPath, dataStr, 'utf-8');
      
      // Atomic rename: On POSIX/Linux, renameSync atomically replaces the destination.
      // We do NOT call unlinkSync first to prevent data loss in case of sudden power cuts.
      try {
        fs.renameSync(tempPath, config.JSON_DB_PATH);
      } catch (renameErr) {
        // Fallback for Windows file-locking or cross-device edge cases
        fs.copyFileSync(tempPath, config.JSON_DB_PATH);
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch {}
        }
      }
      logger.debug('Base de datos guardada de forma atómica en disco.', 'DB');
    } catch (error) {
      logger.error('Fallo al guardar la base de datos en el disco.', error, 'DB');
      // Emergency fallback direct write
      try {
        fs.writeFileSync(config.JSON_DB_PATH, JSON.stringify(dataStore, null, 2), 'utf-8');
      } catch {}
    }
  },

  /**
   * Overwrites the device manifest and active schedules.
   */
  saveManifest: (manifestData) => {
    if (!manifestData) return;
    
    const oldDevices = dataStore.manifest.devices || [];
    const newDevices = manifestData.devices || [];
    const nowStr = moment().tz(config.TIMEZONE).format(config.DATE_TIME_FORMAT);
    
    // Apagar relevadores de dispositivos que fueron removidos o desvinculados del manifiesto
    oldDevices.forEach(oldDev => {
      const stillExists = newDevices.some(d => d.id === oldDev.id);
      if (!stillExists) {
        const msg = `Dispositivo ${oldDev.name} (${oldDev.id}) desvinculado o eliminado del manifiesto. Apagando relevadores...`;
        logger.warn(msg, 'DB');
        const activeLow = oldDev.active_high ? false : (oldDev.active_low !== false);
        if (oldDev.pin != null) {
          const pinStillInUse = newDevices.some(d => d.pin === oldDev.pin || d.compressorPin === oldDev.pin);
          if (!pinStillInUse) {
            try {
              const relay = new hardware.GpioRelay(oldDev.pin, oldDev.device_id, activeLow);
              relay.write(1); // 1 = APAGADO
              relay.release();
            } catch (e) {
              logger.error(`Error apagando pin ${oldDev.pin} de dispositivo eliminado:`, e, 'DB');
            }
          } else {
            logger.info(`Pin ${oldDev.pin} transferido a otro dispositivo en el nuevo manifiesto. Manteniendo estado sin interrupción.`, 'DB');
          }
        }
        if (oldDev.compressorPin != null) {
          const compPinStillInUse = newDevices.some(d => d.pin === oldDev.compressorPin || d.compressorPin === oldDev.compressorPin);
          if (!compPinStillInUse) {
            try {
              const compRelay = new hardware.GpioRelay(oldDev.compressorPin, oldDev.device_id, activeLow);
              compRelay.write(1); // 1 = APAGADO
              compRelay.release();
            } catch (e) {
              logger.error(`Error apagando compressorPin ${oldDev.compressorPin} de dispositivo eliminado:`, e, 'DB');
            }
          } else {
            logger.info(`Pin ${oldDev.compressorPin} transferido a otro dispositivo en el nuevo manifiesto. Manteniendo estado sin interrupción.`, 'DB');
          }
        }
        delete dataStore.deviceStates[oldDev.id];
      }
    });

    newDevices.forEach(newDev => {
      const oldDev = oldDevices.find(d => d.id === newDev.id);
      if (oldDev) {
        if (oldDev.setpoint !== newDev.setpoint) {
          const msg = `Cambio de Setpoint para ${newDev.name}: de ${oldDev.setpoint !== null ? oldDev.setpoint + '°C' : 'Ninguno'} a ${newDev.setpoint !== null ? newDev.setpoint + '°C' : 'Ninguno'} (vía Sincronización)`;
          logger.info(msg, 'DB');
          db.writeDeviceLog(newDev.id, msg);
        }
      } else {
        const msg = `Dispositivo registrado: ${newDev.name} con Setpoint inicial de ${newDev.setpoint !== null ? newDev.setpoint + '°C' : 'Ninguno'}`;
        logger.info(msg, 'DB');
        db.writeDeviceLog(newDev.id, msg);
      }

      // Reconciliar estado runtime preservando temporizadores manuales activos
      const existingState = dataStore.deviceStates[newDev.id] || {};
      const hasActiveManualTimer = existingState.manual_date && nowStr < existingState.manual_date;

      if (newDev.status === 'disabled' || newDev.status === 'inactive' || newDev.status === 'off') {
        dataStore.deviceStates[newDev.id] = {
          ...existingState,
          mode: 'off',
          manual_date: null,
          manual_on: false,
          lastActiveSetpoint: newDev.setpoint ?? existingState.lastActiveSetpoint
        };
      } else if (hasActiveManualTimer) {
        // Preservar la anulación manual temporal activa
        dataStore.deviceStates[newDev.id] = {
          ...existingState,
          mode: existingState.mode || 'manual',
          manual_date: existingState.manual_date,
          manual_on: existingState.manual_on,
          lastActiveSetpoint: newDev.setpoint ?? existingState.lastActiveSetpoint
        };
      } else if (newDev.mode === 'auto' && !newDev.manual_date) {
        dataStore.deviceStates[newDev.id] = {
          ...existingState,
          mode: 'auto',
          manual_date: null,
          manual_on: null,
          lastActiveSetpoint: newDev.setpoint ?? existingState.lastActiveSetpoint
        };
      } else if (newDev.manual_date !== undefined || newDev.manual_on !== undefined || newDev.mode !== undefined) {
        dataStore.deviceStates[newDev.id] = {
          ...existingState,
          mode: newDev.mode || existingState.mode || 'auto',
          manual_date: newDev.manual_date !== undefined ? newDev.manual_date : (existingState.manual_date ?? null),
          manual_on: newDev.manual_on !== undefined ? newDev.manual_on : (existingState.manual_on ?? null),
          lastActiveSetpoint: newDev.setpoint ?? existingState.lastActiveSetpoint
        };
      }
    });

    dataStore.manifest = {
      gatewayId: manifestData.gatewayId || config.GATEWAY_ID,
      devices: manifestData.devices || []
    };
    
    // Extract schedules from devices config
    dataStore.schedules = [];
    dataStore.manifest.devices.forEach(dev => {
      if (dev.schedules && Array.isArray(dev.schedules)) {
        dev.schedules.forEach(sch => {
          dataStore.schedules.push({
            ...sch,
            deviceId: dev.id
          });
        });
      }
    });

    db.save();
    logger.success(`Manifiesto sincronizado: ${dataStore.manifest.devices.length} dispositivos, ${dataStore.schedules.length} calendarios registrados.`, 'DB');
  },

  /**
   * Gets the gateway manifest.
   */
  getManifest: () => {
    return dataStore.manifest;
  },

  /**
   * Gets the list of devices registered in the manifest.
   */
  getDevices: () => {
    return dataStore.manifest.devices || [];
  },

  /**
   * Gets runtime states of all devices.
   */
  getDeviceStates: () => {
    return dataStore.deviceStates;
  },

  /**
   * Gets the runtime state of a specific device.
   */
  getDeviceState: (deviceId) => {
    return dataStore.deviceStates[deviceId] || { on: false, lastTurnedOff: null, currentVal: null };
  },

  /**
   * Saves the runtime state of a specific device.
   */
  saveDeviceState: (deviceId, state) => {
    const oldState = dataStore.deviceStates[deviceId] || {};
    dataStore.deviceStates[deviceId] = {
      ...oldState,
      ...state,
      updatedAt: new Date().toISOString()
    };

    // Mitigación de desgaste de tarjeta SD: Solo guardar físicamente en disco ante cambios de estado críticos.
    const criticalKeys = ['on', 'compressorOn', 'manual_on', 'manual_date', 'lastActiveSetpoint', 'lastTurnedOff', 'lastCompressorOff'];
    const hasCriticalChange = Object.keys(state).some(key => {
      return criticalKeys.includes(key) && oldState[key] !== state[key];
    });

    if (hasCriticalChange) {
      db.save();
    }
  },

  /**
   * Gets schedules matching a deviceId.
   */
  getSchedulesForDevice: (deviceId) => {
    return dataStore.schedules.filter(sch => String(sch.deviceId) === String(deviceId));
  },

  /**
   * Appends telemetry records to the offline queue with batch disk saving.
   */
  queueTelemetry: (telemetryRecord) => {
    const MAX_OFFLINE_TELEMETRY = 500;
    
    // Trim oldest records if buffer is full to prevent storage exhaustion
    if (dataStore.offlineTelemetry.length >= MAX_OFFLINE_TELEMETRY) {
      dataStore.offlineTelemetry = dataStore.offlineTelemetry.slice(-Math.floor(MAX_OFFLINE_TELEMETRY * 0.8));
    }

    dataStore.offlineTelemetry.push({
      ...telemetryRecord,
      queuedAt: new Date().toISOString()
    });

    unsavedTelemetryCount++;
    if (unsavedTelemetryCount >= MAX_UNSAVED_TELEMETRY) {
      if (telemetrySaveTimer) {
        clearTimeout(telemetrySaveTimer);
        telemetrySaveTimer = null;
      }
      unsavedTelemetryCount = 0;
      db.save();
    } else {
      scheduleTelemetrySave();
    }
    logger.warn(`Modo fuera de línea: telemetría en cola. Total en cola: ${dataStore.offlineTelemetry.length}`, 'DB');
  },

  /**
   * Immediately flushes any unsaved offline telemetry queue to disk.
   */
  flushQueuedTelemetrySync: () => {
    if (telemetrySaveTimer) {
      clearTimeout(telemetrySaveTimer);
      telemetrySaveTimer = null;
    }
    unsavedTelemetryCount = 0;
    db.save();
  },

  /**
   * Retrieves all queued telemetry records.
   */
  getQueuedTelemetry: () => {
    return dataStore.offlineTelemetry;
  },

  /**
   * Clears the telemetry queue up to a certain count.
   */
  clearQueuedTelemetry: (count) => {
    if (count >= dataStore.offlineTelemetry.length) {
      dataStore.offlineTelemetry = [];
    } else {
      dataStore.offlineTelemetry = dataStore.offlineTelemetry.slice(count);
    }
    if (telemetrySaveTimer) {
      clearTimeout(telemetrySaveTimer);
      telemetrySaveTimer = null;
    }
    unsavedTelemetryCount = 0;
    db.save();
    logger.info(`Cola de telemetría limpiada. Restantes: ${dataStore.offlineTelemetry.length}`, 'DB');
  },

  /**
   * Enqueues a log entry with batch buffering to prevent SD card wear.
   */
  writeDeviceLog: (deviceId, message) => {
    const timestamp = moment().tz(config.TIMEZONE).format('YYYY-MM-DD HH:mm:ss.SSS');
    logBuffer.push({ deviceId, entry: `[${timestamp}] ${message}\n` });

    if (logBuffer.length >= MAX_BUFFERED_LOGS) {
      db.flushLogs();
    } else {
      scheduleLogFlush();
    }
  },

  /**
   * Flushes buffered device log entries to disk in batch with file size rotation.
   */
  flushLogs: () => {
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    if (logBuffer.length === 0) return;

    const entriesToFlush = logBuffer.splice(0, logBuffer.length);
    const logsByDevice = {};

    entriesToFlush.forEach(item => {
      if (!logsByDevice[item.deviceId]) logsByDevice[item.deviceId] = [];
      logsByDevice[item.deviceId].push(item.entry);
    });

    try {
      const logsDir = path.join(path.dirname(config.JSON_DB_PATH), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      for (const [deviceId, lines] of Object.entries(logsByDevice)) {
        const logFile = path.join(logsDir, `dispositivo_${deviceId}.log`);

        // Log file rotation at 1MB
        if (fs.existsSync(logFile)) {
          try {
            const stats = fs.statSync(logFile);
            if (stats.size > 1024 * 1024) {
              const backupFile = `${logFile}.1`;
              if (fs.existsSync(backupFile)) {
                try { fs.unlinkSync(backupFile); } catch {}
              }
              fs.renameSync(logFile, backupFile);
            }
          } catch {}
        }

        fs.appendFileSync(logFile, lines.join(''), 'utf-8');
      }
    } catch (err) {
      logger.error('Error al volcar logs de dispositivos en disco:', err, 'DB');
    }
  }
};

export default db;
