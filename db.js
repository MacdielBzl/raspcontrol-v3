import fs from 'fs';
import path from 'path';
import moment from 'moment-timezone';
import config from './config.js';
import logger from './logger.js';

let dataStore = {
  manifest: {
    gatewayId: config.GATEWAY_ID,
    devices: []
  },
  deviceStates: {},
  schedules: [],
  offlineTelemetry: []
};

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
   * Safely writes the current dataStore to disk.
   */
  save: () => {
    try {
      const tempPath = `${config.JSON_DB_PATH}.tmp`;
      const dataStr = JSON.stringify(dataStore, null, 2);
      
      fs.writeFileSync(tempPath, dataStr, 'utf-8');
      
      if (fs.existsSync(config.JSON_DB_PATH)) {
        fs.unlinkSync(config.JSON_DB_PATH);
      }
      fs.renameSync(tempPath, config.JSON_DB_PATH);
      logger.debug('Base de datos escrita en el disco.', 'DB');
    } catch (error) {
      // Fallback direct write in case of Windows locking errors or permission limits
      try {
        fs.writeFileSync(config.JSON_DB_PATH, JSON.stringify(dataStore, null, 2), 'utf-8');
        logger.debug('Base de datos escrita en el disco mediante respaldo directo.', 'DB');
      } catch (writeErr) {
        logger.error('Fallo al guardar la base de datos en el disco.', writeErr, 'DB');
      }
    }
  },

  /**
   * Overwrites the device manifest and active schedules.
   */
  saveManifest: (manifestData) => {
    if (!manifestData) return;
    
    // Comparar setpoints de dispositivos nuevos vs viejos para registrar cambios
    const oldDevices = dataStore.manifest.devices || [];
    const newDevices = manifestData.devices || [];
    
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
    // Evitamos guardar si solo cambia la lectura de temperatura o el estado del sensor.
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
    return dataStore.schedules.filter(sch => sch.deviceId === deviceId);
  },

  /**
   * Appends telemetry records to the offline queue.
   */
  queueTelemetry: (telemetryRecord) => {
    dataStore.offlineTelemetry.push({
      ...telemetryRecord,
      queuedAt: new Date().toISOString()
    });
    db.save();
    logger.warn(`Modo fuera de línea: telemetría en cola. Total en cola: ${dataStore.offlineTelemetry.length}`, 'DB');
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
    db.save();
    logger.info(`Cola de telemetría limpiada. Restantes: ${dataStore.offlineTelemetry.length}`, 'DB');
  },

  /**
   * Escribe una entrada en el archivo de log específico de un dispositivo.
   */
  writeDeviceLog: (deviceId, message) => {
    try {
      const logsDir = path.join(path.dirname(config.JSON_DB_PATH), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const logFile = path.join(logsDir, `dispositivo_${deviceId}.log`);

      // Rotación de logs: Limitar el archivo a 1MB
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size > 1024 * 1024) { // 1MB
          const backupFile = `${logFile}.1`;
          if (fs.existsSync(backupFile)) {
            fs.unlinkSync(backupFile);
          }
          fs.renameSync(logFile, backupFile);
        }
      }

      const timestamp = moment().tz(config.TIMEZONE).format('YYYY-MM-DD HH:mm:ss.SSS');
      fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, 'utf-8');
    } catch (err) {
      logger.error(`Error al escribir log del dispositivo ${deviceId}`, err, 'DB');
    }
  }
};

export default db;
