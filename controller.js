import moment from 'moment-timezone';
import config from './config.js';
import logger from './logger.js';
import db from './db.js';
import hardware from './hardware.js';
import wsClient from './websocket.js';

// Cache for instanced hardware relays to avoid re-exporting pins
const relayPins = {};

/**
 * Helper to get or create a GpioRelay instance for a pin.
 */
function getRelayInstance(pin, deviceId) {
  const key = `${pin}-${deviceId || ''}`;
  if (!relayPins[key]) {
    relayPins[key] = new hardware.GpioRelay(pin, deviceId);
  }
  return relayPins[key];
}

/**
 * Checks if the current local time falls within a schedule's active window.
 */
function isScheduleActive(sch) {
  if (!sch.days || !Array.isArray(sch.days)) return false;
  
  const now = moment().tz(config.TIMEZONE);
  const currentDay = now.isoWeekday().toString(); // 1 = Monday, ..., 7 = Sunday
  
  const dayMatches = sch.days.map(String).includes(currentDay);
  if (!dayMatches) return false;
  
  const currentTimeStr = now.format(config.TIME_FORMAT);
  const startTime = sch.startTime || '00:00:00';
  const endTime = sch.endTime || '00:00:00';
  
  return currentTimeStr >= startTime && currentTimeStr <= endTime;
}

let isLoopRunning = false;

export const controller = {
  /**
   * Inicializa el gestor del lazo de control.
   */
  init: () => {
    logger.info('Inicializando el gestor del lazo de control...', 'CTRL');
    controller.run();
  },

  /**
   * Punto de entrada principal para ejecutar un ciclo del lazo de control.
   */
  run: async () => {
    if (isLoopRunning) {
      logger.warn('El ciclo del lazo de control ya está en ejecución. Omitiendo este ciclo.', 'CTRL');
      return;
    }
    isLoopRunning = true;
    try {
      const devices = db.getDevices();
      if (devices.length === 0) {
        logger.debug('No hay dispositivos cargados en el manifiesto. Omitiendo ciclo de control.', 'CTRL');
        isLoopRunning = false;
        return;
      }

      logger.debug('Ejecutando ciclo del lazo de control...', 'CTRL');

      // 1. Recopilar todas las lecturas de los sensores de temperatura en paralelo
      const tempReadings = {};
      await Promise.all(
        devices.map(async (dev) => {
          if (dev.tempId) {
            const res = await hardware.getTemperature(dev.tempId);
            const status = (res && res.status) || 'ERROR';
            if (res && res.success) {
              tempReadings[dev.id] = res.temperature;
              db.saveDeviceState(dev.id, { currentVal: res.temperature, sensorStatus: status });
              logger.info(`Lectura de temperatura para ${dev.name}: ${res.temperature}°C (Estado Sensor: ${status})`, 'CTRL');
              db.writeDeviceLog(dev.id, `Lectura de temperatura: ${res.temperature}°C (Estado Sensor: ${status})`);
            } else {
              db.saveDeviceState(dev.id, { sensorStatus: status });
              logger.warn(`Fallo al leer la temperatura para ${dev.name} (tempId: ${dev.tempId}) - Estado Sensor: ${status}`, 'CTRL');
              db.writeDeviceLog(dev.id, `Error en la lectura de temperatura - Estado Sensor: ${status}`);
            }
          }
        })
      );

      // 2. Evaluar los estados objetivo para cada dispositivo basados en calendarios y termostatos
      const targetStates = {};
      
      for (const dev of devices) {
        // Encontrar calendarios activos para este dispositivo
        const schedules = db.getSchedulesForDevice(dev.id);
        const activeSch = schedules.find(isScheduleActive);
        
        let desiredOn = false;
        let activeSetpoint = dev.setpoint != null ? Number(dev.setpoint) : null;
        
        // Verificación de anulación manual (ej. fecha manual en el futuro)
        const currentState = db.getDeviceState(dev.id);
        const manualDate = dev.manual_date || currentState.manual_date || null;
        const nowStr = moment().tz(config.TIMEZONE).format(config.DATE_TIME_FORMAT);
        const manualActive = manualDate && nowStr < manualDate;
        const manualOn = dev.manual_on !== undefined ? dev.manual_on : (currentState.manual_on !== undefined ? currentState.manual_on : true);

        if (manualActive) {
          desiredOn = manualOn;
          logger.debug(`Control manual activo para el dispositivo ${dev.name}: forzando estado a ${desiredOn ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
          db.writeDeviceLog(dev.id, `Control manual activo: forzando estado a ${desiredOn ? 'ENCENDIDO' : 'APAGADO'}`);
        } else if (activeSch) {
          if (activeSch.action && activeSch.action.setpoint != null) {
            activeSetpoint = Number(activeSch.action.setpoint);
          }
          desiredOn = activeSch.action?.on !== false;
          logger.debug(`Calendario activo aplicado para ${dev.name}: estado deseado ${desiredOn ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
        }

        // Registrar cambios de setpoint dinámicamente si cambia el setpoint activo
        const lastActiveSetpoint = currentState.lastActiveSetpoint !== undefined ? currentState.lastActiveSetpoint : null;
        if (activeSetpoint !== lastActiveSetpoint) {
          const msg = `Cambio de Setpoint activo para ${dev.name}: de ${lastActiveSetpoint !== null ? lastActiveSetpoint + '°C' : 'Ninguno'} a ${activeSetpoint !== null ? activeSetpoint + '°C' : 'Ninguno'}`;
          logger.info(msg, 'CTRL');
          db.writeDeviceLog(dev.id, msg);
          db.saveDeviceState(dev.id, { lastActiveSetpoint: activeSetpoint });
        }

        // Sistema HVAC unificado (Ventilador y Compresor en el mismo dispositivo)
        if (dev.type === 'hvac' || dev.compressorPin != null) {
          let targetFan = false;
          let targetCompressor = false;

          if (desiredOn) {
            targetFan = true; // El ventilador debe estar ENCENDIDO si la unidad HVAC está habilitada

            if (dev.tempId && activeSetpoint !== null) {
              if (tempReadings[dev.id] !== undefined) {
                const currentTemp = tempReadings[dev.id];
                
                // Histéresis del Termostato de Enfriamiento (ENCENDIDO si > setpoint + 0.5, APAGADO si < setpoint - 0.5)
                if (currentTemp > (activeSetpoint + 0.5)) {
                  targetCompressor = true;
                } else if (currentTemp < (activeSetpoint - 0.5)) {
                  targetCompressor = false;
                } else {
                  // Banda muerta de histéresis: mantener estado actual del compresor
                  targetCompressor = currentState.compressorOn || false;
                }
                logger.info(`[Termostato HVAC] ${dev.name}: Temp actual = ${currentTemp}°C, Setpoint = ${activeSetpoint}°C. Compresor objetivo: ${targetCompressor ? 'ENCENDIDO' : 'APAGADO'} (Estado actual: ${currentState.compressorOn ? 'ENCENDIDO' : 'APAGADO'})`, 'CTRL');
              } else {
                // Falló la lectura del sensor de temperatura, apagar el compresor por seguridad
                logger.warn(`Fallo de seguridad: falta lectura de temperatura para HVAC ${dev.name}. Forzando apagado del compresor.`, 'CTRL');
                db.writeDeviceLog(dev.id, 'Fallo de seguridad: falta lectura de temperatura. Forzando apagado del compresor.');
                targetCompressor = false;
              }
            } else {
              // Si no tiene sensor de temperatura configurado o no hay setpoint activo,
              // el compresor simplemente sigue el estado de encendido del HVAC.
              targetCompressor = true;
            }
          } else {
            logger.info(`[Termostato HVAC] ${dev.name}: HVAC apagado/deshabilitado por control manual o fuera de calendario.`, 'CTRL');
          }

          targetStates[dev.id] = {
            fan: targetFan,
            compressor: targetCompressor
          };

        } else {
          // Relevador estándar único / Temporizador / Tomacorriente
          let targetOn = desiredOn;

          const isThermostat = dev.type === 'heater' || dev.type === 'compressor';

          if (isThermostat) {
            if (desiredOn && activeSetpoint !== null) {
              if (tempReadings[dev.id] !== undefined) {
                const currentTemp = tempReadings[dev.id];

                if (dev.type === 'heater') {
                  // Lógica de calefacción
                  if (currentTemp < (activeSetpoint - 0.5)) {
                    targetOn = true;
                  } else if (currentTemp > (activeSetpoint + 0.5)) {
                    targetOn = false;
                  } else {
                    targetOn = currentState.on || false;
                  }
                  logger.info(`[Termostato Calefactor] ${dev.name}: Temp actual = ${currentTemp}°C, Setpoint = ${activeSetpoint}°C. Calefactor objetivo: ${targetOn ? 'ENCENDIDO' : 'APAGADO'} (Estado actual: ${currentState.on ? 'ENCENDIDO' : 'APAGADO'})`, 'CTRL');
                } else if (dev.type === 'compressor') {
                  // Lógica de enfriamiento
                  if (currentTemp > (activeSetpoint + 0.5)) {
                    targetOn = true;
                  } else if (currentTemp < (activeSetpoint - 0.5)) {
                    targetOn = false;
                  } else {
                    targetOn = currentState.on || false;
                  }
                  logger.info(`[Termostato Compresor] ${dev.name}: Temp actual = ${currentTemp}°C, Setpoint = ${activeSetpoint}°C. Compresor objetivo: ${targetOn ? 'ENCENDIDO' : 'APAGADO'} (Estado actual: ${currentState.on ? 'ENCENDIDO' : 'APAGADO'})`, 'CTRL');
                }
              } else {
                // Falta lectura del sensor, forzar apagado por seguridad
                logger.warn(`Fallo de seguridad: falta lectura de temperatura para ${dev.name}. Forzando apagado.`, 'CTRL');
                db.writeDeviceLog(dev.id, 'Fallo de seguridad: falta lectura de temperatura. Forzando apagado.');
                targetOn = false;
              }
            } else if (!desiredOn && activeSetpoint !== null) {
              logger.info(`[Termostato] ${dev.name}: Dispositivo apagado/deshabilitado por control manual o fuera de calendario.`, 'CTRL');
            }
          }

          targetStates[dev.id] = targetOn;
        }
      }

      // 3. Aplicar enclavamientos de seguridad (dependencias Padre/Hijo para configuraciones heredadas)
      for (const dev of devices) {
        if ((dev.type === 'compressor' || dev.type === 'heater') && dev.equipment_id) {
          // Buscar al equipo padre usando la propiedad equipment_id
          const parent = devices.find(d => d.type === 'equipment' && String(d.equipment_id) === String(dev.equipment_id));
          const parentTarget = parent ? targetStates[parent.id] : false;
          if (!parentTarget) {
            const currentTarget = typeof targetStates[dev.id] === 'object' ? targetStates[dev.id].compressor : targetStates[dev.id];
            if (currentTarget) {
              logger.warn(`[Enclavamiento de Seguridad] Forzando el apagado de ${dev.name} porque el equipo padre ${parent ? parent.name : dev.equipment_id} está APAGADO.`, 'CTRL');
              db.writeDeviceLog(dev.id, `Enclavamiento de seguridad: Forzando apagado porque el equipo padre está APAGADO.`);
              
              if (typeof targetStates[dev.id] === 'object') {
                targetStates[dev.id].compressor = false;
              } else {
                targetStates[dev.id] = false;
              }
            }
          }
        }
      }

      // 4. Aplicar salvaguardas de ciclo corto (espera_para_encender)
      const now = Date.now();
      for (const dev of devices) {
        const isHvac = dev.type === 'hvac' || dev.compressorPin != null;
        
        if (isHvac) {
          const target = targetStates[dev.id];
          if (target && target.compressor) {
            const currentState = db.getDeviceState(dev.id);
            // Si el compresor quiere encenderse, pero estaba previamente apagado
            if (!currentState.compressorOn) {
              const lastOff = currentState.lastCompressorOff || 0;
              const waitTimeSeconds = Number(dev.wait_to_turn_on || 0);
              const secondsSinceOff = (now - lastOff) / 1000;

              if (secondsSinceOff < waitTimeSeconds) {
                const remaining = Math.round(waitTimeSeconds - secondsSinceOff);
                logger.info(`[Protección Ciclo Corto] Retrasando compresor HVAC de ${dev.name} (espera_para_encender: ${waitTimeSeconds}s). Restante: ${remaining}s`, 'CTRL');
                db.writeDeviceLog(dev.id, `Protección contra ciclo corto activa. Retrasando arranque del compresor. Restante: ${remaining}s`);
                target.compressor = false; // Retener compresor apagado
              }
            }
          }
        } else {
          // Relevador estándar de compresor o general
          if (targetStates[dev.id]) {
            const currentState = db.getDeviceState(dev.id);
            if (!currentState.on) {
              const lastOff = currentState.lastCompressorOff || 0;
              const waitTimeSeconds = Number(dev.wait_to_turn_on || 0);
              const secondsSinceOff = (now - lastOff) / 1000;

              if (secondsSinceOff < waitTimeSeconds) {
                const remaining = Math.round(waitTimeSeconds - secondsSinceOff);
                logger.info(`[Protección Ciclo Corto] Retrasando ${dev.name} (espera_para_encender: ${waitTimeSeconds}s). Restante: ${remaining}s`, 'CTRL');
                db.writeDeviceLog(dev.id, `Protección contra ciclo corto activa. Retrasando arranque. Restante: ${remaining}s`);
                targetStates[dev.id] = false;
              }
            }
          }
        }
      }

      // 5. Ejecutar estados en el hardware físico y actualizar la base de datos
      for (const dev of devices) {
        const isHvac = dev.type === 'hvac' || dev.compressorPin != null;

        if (isHvac) {
          const target = targetStates[dev.id];
          const currentState = db.getDeviceState(dev.id);

          // Controlar Ventilador (pin)
          const fanRelay = dev.pin != null ? getRelayInstance(dev.pin, dev.device_id) : null;
          if (dev.pin != null && (target.fan !== currentState.on || !fanRelay.hasBeenWritten)) {
            logger.info(`Cambiando Ventilador de HVAC ${dev.name} (Pin ${dev.pin}) a ${target.fan ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
            db.writeDeviceLog(dev.id, `Ventilador cambiado a ${target.fan ? 'ENCENDIDO' : 'APAGADO'} (Pin ${dev.pin})`);
            fanRelay.write(target.fan ? 0 : 1); // 0 = ENCENDIDO, 1 = APAGADO
            db.saveDeviceState(dev.id, { on: target.fan });

            if (target.fan) {
              const powerOnWait = Number(dev.power_on_wait || 0);
              if (powerOnWait > 0) {
                logger.info(`[Retraso de Arranque] Esperando power_on_wait (${powerOnWait}s) antes de continuar para ${dev.name}...`, 'CTRL');
                await new Promise(resolve => setTimeout(resolve, powerOnWait * 1000));
              }
            }
          }

          // Controlar Compresor (compressorPin)
          const compRelay = dev.compressorPin != null ? getRelayInstance(dev.compressorPin, dev.device_id) : null;
          if (dev.compressorPin != null && (target.compressor !== currentState.compressorOn || !compRelay.hasBeenWritten)) {
            logger.info(`Cambiando Compresor de HVAC ${dev.name} (Pin ${dev.compressorPin}) a ${target.compressor ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
            db.writeDeviceLog(dev.id, `Compresor cambiado a ${target.compressor ? 'ENCENDIDO' : 'APAGADO'} (Pin ${dev.compressorPin})`);
            compRelay.write(target.compressor ? 0 : 1);
            
            const extraState = { compressorOn: target.compressor };
            if (!target.compressor) {
              extraState.lastCompressorOff = Date.now();
            }
            
            db.saveDeviceState(dev.id, extraState);
          }

        } else {
          // Relevador estándar único
          if (dev.pin == null) continue;

          const targetOn = targetStates[dev.id];
          const currentState = db.getDeviceState(dev.id);
          const relay = getRelayInstance(dev.pin, dev.device_id);

          if (targetOn !== currentState.on || !relay.hasBeenWritten) {
            logger.info(`Cambiando dispositivo ${dev.name} (Pin ${dev.pin}) a ${targetOn ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
            db.writeDeviceLog(dev.id, `Dispositivo cambiado a ${targetOn ? 'ENCENDIDO' : 'APAGADO'} (Pin ${dev.pin})`);
            
            if (targetOn) {
              relay.write(0);
              db.saveDeviceState(dev.id, { on: true });
              
              const powerOnWait = Number(dev.power_on_wait || 0);
              if (powerOnWait > 0) {
                logger.info(`[Retraso de Arranque] Esperando power_on_wait (${powerOnWait}s) antes de continuar para ${dev.name}...`, 'CTRL');
                await new Promise(resolve => setTimeout(resolve, powerOnWait * 1000));
              }
            } else {
              relay.write(1);
              db.saveDeviceState(dev.id, { on: false, lastTurnedOff: new Date().toISOString(), lastCompressorOff: Date.now() });
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
      }

    } catch (error) {
      logger.error('Ocurrió un error en el ciclo de la tarea de control.', error, 'CTRL');
    } finally {
      isLoopRunning = false;
    }
  },

  /**
   * Maneja los comandos de estado inmediatos recibidos desde el WebSocket.
   */
  handleCommand: async (deviceId, state) => {
    logger.sync(`Ejecutando comando instantáneo para el dispositivo ${deviceId}`, 'CTRL');
    
    const devices = db.getDevices();
    const dev = devices.find(d => d.id === deviceId);
    if (!dev) {
      logger.warn(`Fallo de comando: dispositivo ${deviceId} no encontrado.`, 'CTRL');
      return;
    }

    if (state.on !== undefined) {
      const manualDate = moment().tz(config.TIMEZONE).add(1, 'hour').format(config.DATE_TIME_FORMAT);
      db.saveDeviceState(deviceId, { manual_date: manualDate, manual_on: state.on });
      dev.manual_date = manualDate;
      dev.manual_on = state.on;
      db.writeDeviceLog(deviceId, `Comando instantáneo recibido: forzar estado a ${state.on ? 'ENCENDIDO' : 'APAGADO'}`);
      await controller.run();
    }
  },

  /**
   * Recopila todas las lecturas de los sensores de telemetría y las envía al servidor.
   */
  reportTelemetry: async () => {
    const devices = db.getDevices();
    if (devices.length === 0) return;

    logger.info('Recopilando datos de telemetría de los sensores...', 'CTRL');
    
    const telemetryData = [];
    
    for (const dev of devices) {
      const state = db.getDeviceState(dev.id);
      const isHvac = dev.type === 'hvac' || dev.compressorPin != null;
      
      const record = {
        deviceId: dev.id,
        on: state.on || false,
        lastUpdated: state.updatedAt || new Date().toISOString()
      };

      if (isHvac) {
        record.compressorOn = state.compressorOn || false;
      }

      if (dev.tempId) {
        const tempRes = await hardware.getTemperature(dev.tempId);
        record.sensorStatus = (tempRes && tempRes.status) || 'ERROR';
        if (tempRes && tempRes.success) {
          record.temperature = tempRes.temperature;
        }
      }

      telemetryData.push(record);
    }

    const diskSpace = await hardware.getDiskSpace();
    const selectors = hardware.readSelectorPins();

    wsClient.uploadTelemetry({
      devices: telemetryData,
      metrics: {
        disk: diskSpace,
        selectors: selectors,
        cpuTemp: (await hardware.getTemperature('cpu')).temperature
      }
    });
  }
};

export default controller;
