import moment from 'moment-timezone';
import config from './config.js';
import logger from './logger.js';
import db from './db.js';
import hardware from './hardware.js';
import wsClient from './websocket.js';

// Cache for instanced hardware relays to avoid re-exporting pins
const relayPins = {};

// Reference timestamp for boot protection against immediate restarts
const gatewayStartTime = Date.now();

/**
 * Helper to get or create a GpioRelay instance for a pin.
 */
function getRelayInstance(pin, deviceId, activeLow = true) {
  const normalizedPin = Number(pin);
  const key = `${normalizedPin}-${deviceId || ''}`;
  if (!relayPins[key]) {
    relayPins[key] = new hardware.GpioRelay(normalizedPin, deviceId, activeLow);
  }
  return relayPins[key];
}

/**
 * Checks if the current local time falls within a schedule's active window.
 * Properly handles midnight transitions (e.g., 22:00:00 to 06:00:00 across days).
 */
function isScheduleActive(sch) {
  if (!sch || !sch.days || !Array.isArray(sch.days) || sch.days.length === 0) return false;
  
  const now = moment().tz(config.TIMEZONE);
  const currentDay = now.isoWeekday().toString(); // 1 = Monday, ..., 7 = Sunday
  const yesterdayDay = now.clone().subtract(1, 'day').isoWeekday().toString();
  
  const currentTimeStr = now.format(config.TIME_FORMAT);
  
  const padTime = (t, def) => {
    if (!t) return def;
    const parts = String(t).trim().split(':');
    if (parts.length === 1) return `${parts[0].padStart(2, '0')}:00:00`;
    if (parts.length === 2) return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:00`;
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:${parts[2].padStart(2, '0')}`;
  };

  const startTime = padTime(sch.startTime, '00:00:00');
  const endTime = padTime(sch.endTime, '23:59:59');

  const matchesDay = (dayList, targetDay) => {
    return dayList.some(d => {
      const s = String(d).trim();
      return s === targetDay || (targetDay === '7' && s === '0') || (targetDay === '0' && s === '7');
    });
  };
  
  if (startTime <= endTime) {
    const dayMatches = matchesDay(sch.days, currentDay);
    return dayMatches && currentTimeStr >= startTime && currentTimeStr <= endTime;
  } else {
    // Overnight window (e.g. 22:00:00 to 06:00:00)
    if (currentTimeStr >= startTime) {
      return matchesDay(sch.days, currentDay);
    }
    if (currentTimeStr <= endTime) {
      return matchesDay(sch.days, yesterdayDay);
    }
    return false;
  }
}

// Sequential execution queue for the control loop
let isLoopRunning = false;
let hasPendingRun = false;

export const controller = {
  /**
   * Inicializa el gestor del lazo de control.
   */
  init: () => {
    logger.info('Inicializando el gestor del lazo de control...', 'CTRL');
    controller.run();
  },

  /**
   * Punto de entrada principal para ejecutar un ciclo del lazo de control con cola de ejecución segura.
   */
  run: async () => {
    if (isLoopRunning) {
      hasPendingRun = true;
      logger.debug('El ciclo del lazo de control ya está en ejecución. Marcando ejecución pendiente.', 'CTRL');
      return;
    }

    isLoopRunning = true;

    try {
      const devices = db.getDevices();
      if (devices.length === 0) {
        logger.debug('No hay dispositivos cargados en el manifiesto. Omitiendo ciclo de control.', 'CTRL');
        return;
      }

      logger.debug('Ejecutando ciclo del lazo de control...', 'CTRL');

      // 1. Recopilar lecturas de sensores de temperatura de manera secuencial para evitar contención en el bus 1-Wire
      const tempReadings = {};
      for (const dev of devices) {
        if (dev.tempId) {
          const res = await hardware.getTemperature(dev.tempId);
          const status = (res && res.status) || 'ERROR';
          if (res && res.success && typeof res.temperature === 'number' && !isNaN(res.temperature)) {
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
      }

      // 2. Evaluar los estados objetivo para cada dispositivo basados en calendarios y termostatos
      const targetStates = {};
      
      for (const dev of devices) {
        // Comprobar si el dispositivo está deshabilitado o inactivo en el sistema
        const isDisabled = dev.status === 'disabled' || dev.status === 'inactive' || dev.status === 'off';
        if (isDisabled) {
          logger.info(`Dispositivo ${dev.name} está DESHABILITADO en el sistema. Forzando relevadores a APAGADO.`, 'CTRL');
          db.writeDeviceLog(dev.id, 'Dispositivo deshabilitado en el sistema: forzando apagado de relevadores.');
          if (dev.type === 'hvac' || dev.compressorPin != null) {
            targetStates[dev.id] = { fan: false, compressor: false };
          } else {
            targetStates[dev.id] = false;
          }
          continue;
        }

        const devType = String(dev.type || '').toLowerCase();
        // Sistema de 2 Relevadores: HVAC unificado o Conmutador de Transferencia (Selector + Marcha)
        const isTransferSwitch = dev.isTransferSwitch || (dev.compressorPin != null && devType !== 'hvac');

        // Encontrar calendarios activos para este dispositivo con resolución de prioridad
        const schedules = db.getSchedulesForDevice(dev.id);
        const activeSchedules = schedules.filter(isScheduleActive);
        // Si hay múltiples calendarios activos, priorizar acciones de apagado o bloqueo (seguridad/ahorro)
        let activeSch = null;
        if (activeSchedules.length > 0) {
          activeSch = activeSchedules.find(s => s.action?.on === false || s.action?.lockout === true) || activeSchedules[0];
        }
        
        let desiredOn = false;
        let isLockout = false;
        let shouldSoftTrip = false;
        let activeSetpoint = dev.setpoint != null && !isNaN(Number(dev.setpoint)) ? Number(dev.setpoint) : null;
        
        // Verificación de anulación manual
        const currentState = db.getDeviceState(dev.id);
        const isExplicitAuto = (currentState.mode === 'auto' || dev.mode === 'auto') && !dev.manual_date;
        const isExplicitManual = currentState.mode === 'manual' || dev.mode === 'manual';
        
        let manualActive = false;
        const manualOn = currentState.manual_on !== undefined ? currentState.manual_on : (dev.manual_on !== undefined ? dev.manual_on : (currentState.on !== undefined ? currentState.on : false));

        if (!isExplicitAuto) {
          const manualDate = dev.manual_date || currentState.manual_date || null;
          if (manualDate) {
            const nowStr = moment().tz(config.TIMEZONE).format(config.DATE_TIME_FORMAT);
            manualActive = nowStr < manualDate;
          } else if (isExplicitManual) {
            // Modo manual permanente: no expira automáticamente
            manualActive = true;
          }
        }

        if (manualActive) {
          desiredOn = manualOn;
          logger.debug(`Control manual activo para el dispositivo ${dev.name}: forzando estado a ${desiredOn ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
          db.writeDeviceLog(dev.id, `Control manual activo: forzando estado a ${desiredOn ? 'ENCENDIDO' : 'APAGADO'}`);
        } else if (activeSch) {
          if (activeSch.action && activeSch.action.setpoint != null && !isNaN(Number(activeSch.action.setpoint))) {
            activeSetpoint = Number(activeSch.action.setpoint);
          }
          desiredOn = activeSch.action?.on !== false;
          logger.debug(`Calendario activo aplicado para ${dev.name}: estado deseado ${desiredOn ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');

          if (!desiredOn && isTransferSwitch) {
            isLockout = Boolean(activeSch.action?.lockout === true || activeSch.action?.offMode === 'lockout');
            if (!isLockout) {
              const currentWindowKey = `${activeSch.startTime || '0'}_${activeSch.endTime || '0'}`;
              if (currentState.lastSoftTripKey !== currentWindowKey) {
                shouldSoftTrip = true;
                db.saveDeviceState(dev.id, { lastSoftTripKey: currentWindowKey });
              }
            }
          }
        }

        // Restablecer la llave de soft trip cuando no hay calendario activo o el calendario es de encendido
        if (isTransferSwitch && (desiredOn || !activeSch) && currentState.lastSoftTripKey) {
          db.saveDeviceState(dev.id, { lastSoftTripKey: null });
        }

        // Registrar cambios de setpoint dinámicamente si cambia el setpoint activo
        const lastActiveSetpoint = currentState.lastActiveSetpoint !== undefined ? currentState.lastActiveSetpoint : null;
        if (activeSetpoint !== lastActiveSetpoint) {
          const msg = `Cambio de Setpoint activo para ${dev.name}: de ${lastActiveSetpoint !== null ? lastActiveSetpoint + '°C' : 'Ninguno'} a ${activeSetpoint !== null ? activeSetpoint + '°C' : 'Ninguno'}`;
          logger.info(msg, 'CTRL');
          db.writeDeviceLog(dev.id, msg);
          db.saveDeviceState(dev.id, { lastActiveSetpoint: activeSetpoint });
        }

        if (devType === 'hvac' || dev.compressorPin != null) {
          let targetPin1 = false; // Ventilador (HVAC) o Selector Local/Remoto (Transfer Switch)
          let targetPin2 = false; // Compresor (HVAC) o Señal de Marcha (Transfer Switch)

          if (isTransferSwitch && isLockout) {
            // Modo Secuestro Remoto Total (Lockout): Selector a Remoto (NC abierto / Botonera bloqueada) y Marcha apagada
            targetPin1 = true;
            targetPin2 = false;
            logger.info(`[Conmutador Transferencia] ${dev.name}: Modo SECUESTRO REMOTO TOTAL (Lockout) activo. Botonera física inhibida.`, 'CTRL');
          } else if (desiredOn) {
            targetPin1 = true; // Selector a Modo Remoto (o Ventilador encendido)

            if (dev.tempId && activeSetpoint !== null) {
              if (tempReadings[dev.id] !== undefined && !isNaN(tempReadings[dev.id])) {
                const currentTemp = tempReadings[dev.id];
                
                // Histéresis de Enfriamiento / Termostato (ENCENDIDO si > setpoint + 0.5, APAGADO si < setpoint - 0.5)
                if (currentTemp > (activeSetpoint + 0.5)) {
                  targetPin2 = true;
                } else if (currentTemp < (activeSetpoint - 0.5)) {
                  targetPin2 = false;
                } else {
                  // Banda muerta de histéresis: mantener estado actual
                  targetPin2 = currentState.compressorOn || false;
                }
                const labelTag = isTransferSwitch ? '[Conmutador Transferencia]' : '[Termostato HVAC]';
                logger.info(`${labelTag} ${dev.name}: Temp actual = ${currentTemp}°C, Setpoint = ${activeSetpoint}°C. Marcha/Compresor objetivo: ${targetPin2 ? 'ENCENDIDO' : 'APAGADO'} (Estado actual: ${currentState.compressorOn ? 'ENCENDIDO' : 'APAGADO'})`, 'CTRL');
              } else {
                // Falló la lectura del sensor de temperatura, apagar la carga por seguridad
                logger.warn(`Fallo de seguridad: falta lectura de temperatura para ${dev.name}. Forzando apagado de marcha/compresor.`, 'CTRL');
                db.writeDeviceLog(dev.id, 'Fallo de seguridad: falta lectura de temperatura. Forzando apagado de marcha/compresor.');
                targetPin2 = false;
              }
            } else {
              // Si no tiene sensor de temperatura configurado o no hay setpoint activo,
              // la marcha/compresor sigue directamente la orden del equipo.
              targetPin2 = true;
            }
          } else {
            const labelTag = isTransferSwitch ? '[Conmutador Transferencia]' : '[Termostato HVAC]';
            logger.info(`${labelTag} ${dev.name}: Equipo apagado/en reposo (Botonera física habilitada si es conmutador).`, 'CTRL');
          }

          targetStates[dev.id] = {
            fan: targetPin1,
            compressor: targetPin2,
            shouldSoftTrip: Boolean(shouldSoftTrip)
          };

        } else {
          // Relevador estándar único / Temporizador / Tomacorriente
          let targetOn = desiredOn;
          const isThermostat = devType === 'heater' || devType === 'compressor';

          if (isThermostat) {
            if (desiredOn && activeSetpoint !== null) {
              if (tempReadings[dev.id] !== undefined && !isNaN(tempReadings[dev.id])) {
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

      // 3. Aplicar enclavamientos de seguridad (evaluando correctamente padres booleanos y estructurados)
      // Ejecutar en bucle de propagación para resolver cadenas jerárquicas (A -> B -> C)
      let interlockChanged = true;
      let interlockPasses = 0;
      while (interlockChanged && interlockPasses < devices.length) {
        interlockChanged = false;
        interlockPasses++;

        for (const dev of devices) {
          if (dev.equipment_id) {
            // Comparar estrictamente contra el ID del equipo padre (no contra hermanos que compartan equipment_id)
            const parent = devices.find(d => String(d.id) === String(dev.equipment_id) || String(d._id) === String(dev.equipment_id));
            const parentTarget = parent ? targetStates[parent.id] : false;
            
            // Un equipo padre está activo si es true o si es un objeto con fan o compressor en true
            const isParentOn = parentTarget && (typeof parentTarget === 'object' ? Boolean(parentTarget.fan || parentTarget.compressor) : Boolean(parentTarget));
            
            if (!isParentOn) {
              const currentTarget = typeof targetStates[dev.id] === 'object' 
                ? (targetStates[dev.id].fan || targetStates[dev.id].compressor) 
                : targetStates[dev.id];

              if (currentTarget) {
                logger.warn(`[Enclavamiento de Seguridad] Forzando el apagado de ${dev.name} porque el equipo padre ${parent ? parent.name : dev.equipment_id} está APAGADO.`, 'CTRL');
                db.writeDeviceLog(dev.id, `Enclavamiento de seguridad: Forzando apagado porque el equipo padre está APAGADO.`);
                
                if (typeof targetStates[dev.id] === 'object') {
                  targetStates[dev.id].fan = false;
                  targetStates[dev.id].compressor = false;
                } else {
                  targetStates[dev.id] = false;
                }
                interlockChanged = true;
              }
            }
          }
        }
      }

      // 4. Aplicar salvaguardas de ciclo corto con protección de arranque de gateway (espera_para_encender)
      const now = Date.now();
      for (const dev of devices) {
        const dType = String(dev.type || '').toLowerCase();
        const isHvac = dType === 'hvac' || dev.compressorPin != null;
        const waitTimeSeconds = Number(dev.wait_to_turn_on || 0);

        if (waitTimeSeconds > 0) {
          if (isHvac) {
            const target = targetStates[dev.id];
            if (target && target.compressor) {
              const currentState = db.getDeviceState(dev.id);
              if (!currentState.compressorOn) {
                // Considerar el último apagado o el inicio del gateway para proteger compresores tras cortes eléctricos
                const lastOff = Math.max(currentState.lastCompressorOff || 0, gatewayStartTime);
                const secondsSinceOff = (now - lastOff) / 1000;

                if (secondsSinceOff < waitTimeSeconds) {
                  const remaining = Math.round(waitTimeSeconds - secondsSinceOff);
                  logger.info(`[Protección Ciclo Corto] Retrasando compresor HVAC de ${dev.name} (espera_para_encender: ${waitTimeSeconds}s). Restante: ${remaining}s`, 'CTRL');
                  db.writeDeviceLog(dev.id, `Protección contra ciclo corto activa. Retrasando arranque del compresor. Restante: ${remaining}s`);
                  target.compressor = false;
                }
              }
            }
          } else {
            if (targetStates[dev.id]) {
              const currentState = db.getDeviceState(dev.id);
              if (!currentState.on) {
                const lastOff = Math.max(currentState.lastCompressorOff || 0, gatewayStartTime);
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
      }

      // 5. Ejecutar estados en el hardware físico y actualizar la base de datos
      for (const dev of devices) {
        const dType = String(dev.type || '').toLowerCase();
        const isTransferSwitch = dev.isTransferSwitch || (dev.compressorPin != null && dType !== 'hvac');
        const isHvac = dType === 'hvac' || dev.compressorPin != null;
        const activeLow = dev.active_high ? false : (dev.active_low !== false);

        if (isHvac) {
          const target = targetStates[dev.id];
          const currentState = db.getDeviceState(dev.id);
          const namePin1 = isTransferSwitch ? 'Selector Modo Remoto' : 'Ventilador';
          const namePin2 = isTransferSwitch ? 'Marcha / Arranque' : 'Compresor';

          const relay1 = dev.pin != null ? getRelayInstance(dev.pin, dev.device_id, activeLow) : null;
          const relay2 = dev.compressorPin != null ? getRelayInstance(dev.compressorPin, dev.device_id, activeLow) : null;

          // Secuencia segura de conmutación:
          // Al APAGAR: Apagar primero la marcha/compresor (Pin 2), esperar desexcitación, y luego apagar selector (Pin 1) a NC.
          const isTurningOffBoth = !target.compressor && !target.fan;

          if (isTurningOffBoth) {
            // 1. Apagar Relevador 2 (Marcha / Compresor)
            if (dev.compressorPin != null && (target.compressor !== currentState.compressorOn || !relay2.hasBeenWritten)) {
              logger.info(`Cambiando ${namePin2} de ${dev.name} (Pin ${dev.compressorPin}) a APAGADO`, 'CTRL');
              db.writeDeviceLog(dev.id, `${namePin2} cambiado a APAGADO (Pin ${dev.compressorPin})`);
              await relay2.write(1);
              db.saveDeviceState(dev.id, { compressorOn: false, lastCompressorOff: Date.now() });

              if (isTransferSwitch) {
                // Pequeña pausa de seguridad antes de soltar el selector
                await new Promise(resolve => setTimeout(resolve, 800));
              }
            }

            // 2. Si se solicitó un pulso de desconexión activa (Soft Trip) para romper la retención de un contactor encendido en local
            if (isTransferSwitch && target.shouldSoftTrip && dev.pin != null) {
              logger.info(`[Conmutador Transferencia] Emitiendo pulso de desconexión activa (Soft Trip) en ${dev.name} (Pin ${dev.pin}) para botar retención local...`, 'CTRL');
              db.writeDeviceLog(dev.id, `Pulso de desconexión activa (Soft Trip) emitido en Pin ${dev.pin} para botar retención local.`);
              await relay1.write(0); // Energizar selector (abre contacto NC y tumba la bobina del contactor)
              await new Promise(resolve => setTimeout(resolve, 2000));
              await relay1.write(1); // Regresar selector a NC
              logger.info(`[Conmutador Transferencia] Selector regresó a NC en ${dev.name}. Botonera física local habilitada para rearme manual.`, 'CTRL');
              db.saveDeviceState(dev.id, { on: false });
            } else if (dev.pin != null && (target.fan !== currentState.on || !relay1.hasBeenWritten)) {
              // 3. Apagar Relevador 1 (Selector / Ventilador) a NC
              logger.info(`Cambiando ${namePin1} de ${dev.name} (Pin ${dev.pin}) a APAGADO (Retorno a NC / Local)`, 'CTRL');
              db.writeDeviceLog(dev.id, `${namePin1} cambiado a APAGADO (Pin ${dev.pin})`);
              await relay1.write(1);
              db.saveDeviceState(dev.id, { on: false });
            }

          } else {
            // Al ENCENDER (o mantener encendido / secuestro remoto):
            // 1. Encender Relevador 1 (Selector a Remoto / Ventilador)
            if (dev.pin != null && (target.fan !== currentState.on || !relay1.hasBeenWritten)) {
              logger.info(`Cambiando ${namePin1} de ${dev.name} (Pin ${dev.pin}) a ${target.fan ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
              db.writeDeviceLog(dev.id, `${namePin1} cambiado a ${target.fan ? 'ENCENDIDO' : 'APAGADO'} (Pin ${dev.pin})`);
              await relay1.write(target.fan ? 0 : 1);
              db.saveDeviceState(dev.id, { on: target.fan });

              if (target.fan && target.compressor) {
                const powerOnWait = Number(dev.power_on_wait || (isTransferSwitch ? 2 : 0));
                if (powerOnWait > 0) {
                  logger.info(`[Retraso de Conmutación] Esperando ${powerOnWait}s para estabilización antes de activar ${namePin2} en ${dev.name}...`, 'CTRL');
                  await new Promise(resolve => setTimeout(resolve, powerOnWait * 1000));
                }
              }
            }

            // 2. Encender/Apagar Relevador 2 (Marcha / Compresor)
            if (dev.compressorPin != null && (target.compressor !== currentState.compressorOn || !relay2.hasBeenWritten)) {
              logger.info(`Cambiando ${namePin2} de ${dev.name} (Pin ${dev.compressorPin}) a ${target.compressor ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
              db.writeDeviceLog(dev.id, `${namePin2} cambiado a ${target.compressor ? 'ENCENDIDO' : 'APAGADO'} (Pin ${dev.compressorPin})`);
              await relay2.write(target.compressor ? 0 : 1);
              
              const extraState = { compressorOn: target.compressor };
              if (!target.compressor) {
                extraState.lastCompressorOff = Date.now();
              }
              
              db.saveDeviceState(dev.id, extraState);
            }
          }

        } else {
          // Relevador estándar único
          if (dev.pin == null) continue;

          const targetOn = targetStates[dev.id];
          const currentState = db.getDeviceState(dev.id);
          const relay = getRelayInstance(dev.pin, dev.device_id, activeLow);

          if (targetOn !== currentState.on || !relay.hasBeenWritten) {
            logger.info(`Cambiando dispositivo ${dev.name} (Pin ${dev.pin}) a ${targetOn ? 'ENCENDIDO' : 'APAGADO'}`, 'CTRL');
            db.writeDeviceLog(dev.id, `Dispositivo cambiado a ${targetOn ? 'ENCENDIDO' : 'APAGADO'} (Pin ${dev.pin})`);
            
            if (targetOn) {
              await relay.write(0);
              db.saveDeviceState(dev.id, { on: true });
              
              const powerOnWait = Number(dev.power_on_wait || 0);
              if (powerOnWait > 0) {
                logger.info(`[Retraso de Arranque] Esperando power_on_wait (${powerOnWait}s) antes de continuar para ${dev.name}...`, 'CTRL');
                await new Promise(resolve => setTimeout(resolve, powerOnWait * 1000));
              }
            } else {
              await relay.write(1);
              db.saveDeviceState(dev.id, { on: false, lastTurnedOff: new Date().toISOString(), lastCompressorOff: Date.now() });
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        }
      }

    } catch (error) {
      logger.error('Ocurrió un error en el ciclo de la tarea de control.', error, 'CTRL');
    } finally {
      isLoopRunning = false;
      if (hasPendingRun) {
        hasPendingRun = false;
        logger.debug('Procesando ejecución pendiente encolada del lazo de control...', 'CTRL');
        setTimeout(() => {
          controller.run();
        }, 50);
      }
    }
  },

  /**
   * Maneja los comandos de estado inmediatos recibidos desde el WebSocket.
   */
  handleCommand: async (deviceId, state) => {
    if (!state) return;
    logger.sync(`Ejecutando comando instantáneo para el dispositivo ${deviceId}: ${JSON.stringify(state)}`, 'CTRL');
    
    const devices = db.getDevices();
    const dev = devices.find(d => d.id === deviceId);
    if (!dev) {
      logger.warn(`Fallo de comando: dispositivo ${deviceId} no encontrado.`, 'CTRL');
      return;
    }

    // 1. Manejo de cambio de Setpoint / Temperatura
    if (state.setpoint !== undefined || state.SET_TEMPERATURE !== undefined || state.SET_SETPOINT !== undefined) {
      const newSetpoint = Number(state.setpoint ?? state.SET_TEMPERATURE ?? state.SET_SETPOINT);
      if (!isNaN(newSetpoint)) {
        dev.setpoint = newSetpoint;
        db.saveDeviceState(deviceId, { lastActiveSetpoint: newSetpoint });
        db.writeDeviceLog(deviceId, `Comando instantáneo recibido: actualizar Setpoint a ${newSetpoint}°C`);
        logger.info(`Setpoint de ${dev.name} actualizado a ${newSetpoint}°C vía comando.`, 'CTRL');

        // Si el dispositivo está controlado por Modbus Honeywell, transmitir el setpoint al termostato físico
        const modbusTarget = (dev.pin >= 200 || dev.compressorPin >= 200) ? dev.device_id : (dev.tempId && (dev.tempId.startsWith('/dev/') || dev.tempId.includes('.') || dev.tempId.includes('tty')) ? dev.tempId : null);
        if (modbusTarget) {
          import('./modbus_honeywell.js').then(({ getModbusRTUClient, getModbusTCPClient }) => {
            const isRTU = modbusTarget.startsWith('/dev/') || modbusTarget.includes('tty') || modbusTarget.includes('COM');
            const client = isRTU ? getModbusRTUClient(modbusTarget) : getModbusTCPClient(modbusTarget);
            client.writeSetpoint(newSetpoint).catch(err => {
              logger.error(`Error escribiendo setpoint en termostato Modbus ${modbusTarget}:`, err, 'CTRL');
            });
          }).catch(() => {});
        }
      }
    }

    // 2. Modo Automático (restablecer a programación horaria)
    if (state.mode === 'auto' || state.clear_manual === true || state.auto === true) {
      db.saveDeviceState(deviceId, { manual_date: null, manual_on: null, mode: 'auto' });
      dev.manual_date = null;
      dev.manual_on = null;
      dev.mode = 'auto';
      db.writeDeviceLog(deviceId, 'Comando instantáneo recibido: restaurar modo AUTOMÁTICO (por horario)');
      logger.info(`Dispositivo ${dev.name} restablecido a modo AUTOMÁTICO (por horario).`, 'CTRL');

      // Forzar evaluación y escritura física del relevador
      if (dev.pin != null) {
        const relay = getRelayInstance(dev.pin, dev.device_id, !dev.active_high);
        relay.hasBeenWritten = false;
      }
      if (dev.compressorPin != null) {
        const compRelay = getRelayInstance(dev.compressorPin, dev.device_id, !dev.active_high);
        compRelay.hasBeenWritten = false;
      }

      db.save();
      await controller.run();
      await controller.reportTelemetry();
    } 
    // 3. Modo Manual / Temporizador / Forzado de Encendido o Apagado / Cambio de Modo
    else if (state.on !== undefined || state.timer !== undefined || state.mode !== undefined) {
      let manualDate = null;
      if (state.timer && !isNaN(Number(state.timer))) {
        manualDate = moment().tz(config.TIMEZONE).add(Number(state.timer), 'minutes').format(config.DATE_TIME_FORMAT);
      }
      
      const currentState = db.getDeviceState(deviceId);
      const targetOn = state.on !== undefined 
        ? Boolean(state.on) 
        : (state.mode === 'off' ? false : (currentState.on !== undefined ? currentState.on : (dev.manual_on !== null && dev.manual_on !== undefined ? dev.manual_on : (dev.state?.on || false))));
      const targetMode = state.mode || (state.on !== undefined ? 'manual' : dev.mode || 'manual');

      db.saveDeviceState(deviceId, { manual_date: manualDate, manual_on: targetOn, mode: targetMode });
      dev.manual_date = manualDate;
      dev.manual_on = targetOn;
      dev.mode = targetMode;

      db.writeDeviceLog(deviceId, `Comando instantáneo recibido: forzar estado a ${targetOn ? 'ENCENDIDO' : 'APAGADO'}${state.timer ? ` (temporizador por ${state.timer} min)` : ` (modo ${targetMode})`}`);
      logger.info(`Dispositivo ${dev.name} establecido en modo ${targetMode} (${targetOn ? 'ENCENDIDO' : 'APAGADO'})`, 'CTRL');

      // Forzar que el relevador físico ejecute la conmutación de inmediato
      if (dev.pin != null) {
        const relay = getRelayInstance(dev.pin, dev.device_id, !dev.active_high);
        relay.hasBeenWritten = false;
      }
      if (dev.compressorPin != null) {
        const compRelay = getRelayInstance(dev.compressorPin, dev.device_id, !dev.active_high);
        compRelay.hasBeenWritten = false;
      }

      db.save();
      await controller.run();
      await controller.reportTelemetry();
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
      const isHvac = String(dev.type || '').toLowerCase() === 'hvac' || dev.compressorPin != null;
      
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
        if (tempRes && tempRes.success && typeof tempRes.temperature === 'number' && !isNaN(tempRes.temperature)) {
          record.temperature = tempRes.temperature;
        }
      }

      telemetryData.push(record);
    }

    const diskSpace = await hardware.getDiskSpace();
    const selectors = hardware.readSelectorPins();
    const cpuTempRes = await hardware.getTemperature('cpu');

    wsClient.uploadTelemetry({
      devices: telemetryData,
      metrics: {
        disk: diskSpace,
        selectors: selectors,
        cpuTemp: cpuTempRes?.temperature || 0
      }
    });
  }
};

export default controller;
