import fs from 'fs';
import { exec, execSync } from 'child_process';
import config from './config.js';
import logger from './logger.js';

// Physical selectors array (empty by default: all pins and sensors must come dynamically from the manifest)
const READ_PIN_SELECTORS = [];

let Gpio;
let isMockHardware = config.HARDWARE_MODE === 'MOCK';
const selectorGpios = {};

// Attempt to load optional I2C expansions (MCP23017)
let i2c;
let bus;
const MCP23017_ADDRESS = 0x20; // Default address for MCP23017

// MCP23017 Register Constants
const IODIRA = 0x00; // Direction of Port A (0 = output, 1 = input)
const IODIRB = 0x01; // Direction of Port B
const GPIOA = 0x12; // Output state register Port A
const GPIOB = 0x13; // Output state register Port B

// Cache current state (Default to all relays OFF / high active-low state)
let portAState = 0xFF;
let portBState = 0xFF;

if (process.platform === 'win32') {
  isMockHardware = true;
}

// Initialize native libraries if not in Mock mode
if (!isMockHardware) {
  try {
    const onoff = await import('onoff');
    Gpio = onoff.Gpio;
  } catch (error) {
    logger.warn(`Hardware nativo (onoff/Raspberry Pi) no disponible: ${error.message}. Forzando modo de hardware simulado (MOCK).`, 'HW');
    isMockHardware = true;
  }
}

if (!isMockHardware) {
  try {
    i2c = await import('i2c-bus');
    bus = i2c.openSync(1); // Open standard I2C bus 1 on Raspberry Pi

    // Configure MCP23017 ports as outputs (write 0x00)
    bus.writeByteSync(MCP23017_ADDRESS, IODIRA, 0x00);
    bus.writeByteSync(MCP23017_ADDRESS, IODIRB, 0x00);

    // Write default state (all 1s/relays OFF)
    bus.writeByteSync(MCP23017_ADDRESS, GPIOA, portAState);
    bus.writeByteSync(MCP23017_ADDRESS, GPIOB, portBState);
    logger.success('Expansor I2C MCP23017 inicializado en la dirección 0x20.', 'HW');
  } catch (err) {
    logger.warn('No se pudo inicializar el MCP23017 en el bus I2C. Continuando sin el expansor.', 'HW');
  }
}

/**
 * GPIO, MCP23017 & Modbus Honeywell Hybrid Relay Controller
 */
export class GpioRelay {
  constructor(pin, deviceId = null) {
    this.pin = Number(pin);
    this.deviceId = deviceId; // deviceId acts as Modbus IP if pin >= 200
    this.isI2C = this.pin >= 100 && this.pin < 200;
    this.isModbus = this.pin >= 200;
    this.mcpPin = this.isI2C ? this.pin - 100 : this.pin;
    this.gpio = null;
    this.hasBeenWritten = false;

    if (!isMockHardware) {
      if (!this.isI2C && !this.isModbus) {
        try {
          if (Gpio) {
            this.gpio = new Gpio(this.pin, 'out');
          }
        } catch (err) {
          logger.debug(`onoff (sysfs) no disponible para el pin ${this.pin} (${err.message}). Se usará controlador nativo alternativo (pinctrl/gpiod).`, 'HW');
        }
      }
    }
  }

  write(value) {
    this.hasBeenWritten = true;
    if (isMockHardware) {
      if (this.isModbus) {
        const isRTU = this.deviceId && (this.deviceId.startsWith('/dev/') || this.deviceId.includes('tty') || this.deviceId.includes('COM'));
        if (isRTU) {
          logger.hw(`[MOCK Modbus RTU] Escribiendo Relevador (valor: ${value === 0 ? 'ENCENDIDO' : 'APAGADO'}) en el Termostato Honeywell serie: ${this.deviceId}`, 'HW');
        } else {
          logger.hw(`[MOCK Modbus TCP] Escribiendo Relevador (valor: ${value === 0 ? 'ENCENDIDO' : 'APAGADO'}) en el Termostato Honeywell IP: ${this.deviceId}`, 'HW');
        }
      } else {
        logger.hw(`[SIMULACIÓN ${this.isI2C ? 'I2C MCP23017' : 'GPIO'}] Pin ${this.pin} (McpPin: ${this.mcpPin}) establecido en ${value === 0 ? '0 (ENCENDIDO)' : '1 (APAGADO)'}`, 'HW');
      }
      return;
    }

    if (this.isModbus) {
      const isRTU = this.deviceId && (this.deviceId.startsWith('/dev/') || this.deviceId.includes('tty') || this.deviceId.includes('COM'));
      const isTCP = this.deviceId && (this.deviceId.includes('.') || this.deviceId.startsWith('192.'));

      if (isRTU) {
        import('./modbus_honeywell.js').then(({ getModbusRTUClient }) => {
          const client = getModbusRTUClient(this.deviceId);
          client.writeSystemMode(value === 0).catch(err => {
            logger.error(`[Error Modbus RTU] Fallo al escribir el modo de sistema en ${this.deviceId}`, err, 'HW');
          });
        }).catch(err => {
          logger.error('Fallo al cargar el módulo Modbus RTU', err, 'HW');
        });
      } else if (isTCP) {
        import('./modbus_honeywell.js').then(({ getModbusTCPClient }) => {
          const client = getModbusTCPClient(this.deviceId);
          client.writeSystemMode(value === 0).catch(err => {
            logger.error(`[Error Modbus TCP] Fallo al escribir el modo de sistema en ${this.deviceId}`, err, 'HW');
          });
        }).catch(err => {
          logger.error('Fallo al cargar el módulo Modbus TCP', err, 'HW');
        });
      } else {
        logger.warn(`[Advertencia Modbus] Cadena de conexión Modbus no válida: ${this.deviceId}`, 'HW');
      }
    } else if (this.isI2C && bus) {
      try {
        const isPortB = this.mcpPin >= 8;
        const bitPosition = isPortB ? this.mcpPin - 8 : this.mcpPin;
        const register = isPortB ? GPIOB : GPIOA;
        let currentState = isPortB ? portBState : portAState;

        if (value === 0) {
          currentState &= ~(1 << bitPosition); // Set bit low (ON for active-low)
        } else {
          currentState |= (1 << bitPosition);  // Set bit high (OFF for active-low)
        }

        if (isPortB) {
          portBState = currentState;
        } else {
          portAState = currentState;
        }

        bus.writeByteSync(MCP23017_ADDRESS, register, currentState);
      } catch (err) {
        logger.error(`[Error I2C] Fallo al escribir el pin ${this.pin} en el MCP23017`, err, 'HW');
      }
    } else if (this.gpio) {
      try {
        this.gpio.writeSync(value);
      } catch (err) {
        logger.error(`[Error GPIO] Fallo al escribir el pin ${this.pin}`, err, 'HW');
      }
    } else {
      // Driver CLI alternativo (pinctrl / gpioset / raspi-gpio) para Bookworm y Raspberry Pi 5
      const execOpts = { encoding: 'utf-8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] };
      const levelStr = value === 0 ? 'dl' : 'dh'; // active low / active high
      const levelBit = value === 0 ? 0 : 1;
      let written = false;

      // 1. Probar pinctrl (Estándar oficial en Raspberry Pi OS Bookworm)
      try {
        execSync(`pinctrl set ${this.pin} op ${levelStr}`, execOpts);
        written = true;
      } catch {
        try {
          execSync(`sudo pinctrl set ${this.pin} op ${levelStr}`, execOpts);
          written = true;
        } catch { }
      }

      // 2. Probar gpioset (gpiod en Linux kernel 6.x+)
      if (!written) {
        try {
          execSync(`gpioset 0 ${this.pin}=${levelBit}`, execOpts);
          written = true;
        } catch {
          try {
            execSync(`gpioset 4 ${this.pin}=${levelBit}`, execOpts); // Chip GPIO en Raspberry Pi 5
            written = true;
          } catch { }
        }
      }

      // 3. Probar raspi-gpio (Raspberry Pi OS Bullseye/Buster)
      if (!written) {
        try {
          execSync(`raspi-gpio set ${this.pin} op ${levelStr}`, execOpts);
          written = true;
        } catch {
          try {
            execSync(`sudo raspi-gpio set ${this.pin} op ${levelStr}`, execOpts);
            written = true;
          } catch { }
        }
      }

      if (!written) {
        logger.error(`[Error GPIO] No se pudo escribir en el pin ${this.pin} (onoff y herramientas CLI fallaron)`, null, 'HW');
      }
    }
  }

  release() {
    if (!isMockHardware && !this.isI2C && !this.isModbus && this.gpio) {
      try {
        this.gpio.unexport();
      } catch { }
    }
  }
}

/**
 * DS18B20 1-Wire Temperature Reading (Pure JS)
 */
async function readDS18B20Raw(sensorId) {
  const devicePath = `/sys/bus/w1/devices/${sensorId}/w1_slave`;
  try {
    try {
      await fs.promises.access(devicePath);
    } catch {
      return { value: null, status: 'DISCONNECTED' };
    }

    const data = await fs.promises.readFile(devicePath, 'utf-8');
    const lines = data.split('\n');

    if (lines.length >= 2) {
      if (!lines[0].includes('YES')) {
        return { value: null, status: 'CRC_ERROR' };
      }
      const tempIndex = lines[1].indexOf('t=');
      if (tempIndex !== -1) {
        const tempString = lines[1].substring(tempIndex + 2).trim();
        const tempC = parseFloat(tempString) / 1000.0;
        if (!isNaN(tempC)) {
          if (tempC === 85.0) {
            return { value: tempC, status: 'FAULT_85C' };
          }
          if (tempC === 127.75) {
            return { value: tempC, status: 'FAULT_127C' };
          }
          if (tempC < -55.0 || tempC > 125.0) {
            return { value: tempC, status: 'INVALID_RANGE' };
          }
          return { value: tempC, status: 'OK' };
        }
      }
    }
  } catch (err) {
    logger.error(`Error al leer el sensor ${sensorId}`, err, 'HW');
  }
  return { value: null, status: 'UNKNOWN_ERROR' };
}

function getMedian(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

const tempCache = {};
const CACHE_TTL_MS = 5000;

/**
 * Reads temperature from CPU, 1-wire DS18B20, or Modbus.
 * Implements 5 second cache.
 */
export async function getTemperature(sensorId) {
  const now = Date.now();
  if (sensorId && tempCache[sensorId]) {
    const cached = tempCache[sensorId];
    if (now - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  if (sensorId) {
    const isRTU = sensorId.startsWith('/dev/') || sensorId.includes('tty') || sensorId.includes('COM');
    const isTCP = sensorId.includes('.') || sensorId.startsWith('192.');

    if (isRTU) {
      try {
        const { getModbusRTUClient } = await import('./modbus_honeywell.js');
        const client = getModbusRTUClient(sensorId);
        const temp = await client.readTemperature();
        const response = { success: temp !== 999, temperature: temp, status: temp !== 999 ? 'OK' : 'MODBUS_ERROR' };
        tempCache[sensorId] = { timestamp: now, data: response };
        return response;
      } catch (err) {
        logger.error('Fallo al importar o leer el sensor Modbus RTU', err, 'HW');
      }
    } else if (isTCP) {
      try {
        const { getModbusTCPClient } = await import('./modbus_honeywell.js');
        const client = getModbusTCPClient(sensorId);
        const temp = await client.readTemperature();
        const response = { success: temp !== 999, temperature: temp, status: temp !== 999 ? 'OK' : 'MODBUS_ERROR' };
        tempCache[sensorId] = { timestamp: now, data: response };
        return response;
      } catch (err) {
        logger.error('Fallo al importar o leer el sensor Modbus TCP', err, 'HW');
      }
    }
  }

  if (sensorId === 'cpu') {
    let response;
    try {
      const tempPath = '/sys/class/thermal/thermal_zone0/temp';
      if (fs.existsSync(tempPath)) {
        const raw = fs.readFileSync(tempPath, 'utf-8');
        const tempC = parseFloat(raw.trim()) / 1000.0;
        if (!isNaN(tempC)) {
          response = { success: true, temperature: parseFloat(tempC.toFixed(2)), status: 'OK' };
        }
      }
    } catch (err) {
      logger.error('Error al leer la temperatura del CPU', err, 'HW');
    }
    if (!response) {
      const simulatedCpu = 40.0 + Math.random() * 10.0;
      response = { success: true, temperature: parseFloat(simulatedCpu.toFixed(2)), status: 'OK' };
    }
    tempCache[sensorId] = { timestamp: now, data: response };
    return response;
  }

  if (isMockHardware || !sensorId) {
    const simulatedTemp = 20.0 + Math.random() * 6.0;
    const response = { success: true, temperature: parseFloat(simulatedTemp.toFixed(2)), status: 'OK' };
    tempCache[sensorId || 'mock'] = { timestamp: now, data: response };
    return response;
  }

  const NUMBER_OF_SAMPLES = config.ONEWIRE_SAMPLES || 5;
  const SAMPLE_DELAY_MS = config.ONEWIRE_SAMPLE_DELAY_MS || 1000;
  const NUMBER_OF_ATTEMPTS = config.ONEWIRE_MAX_ATTEMPTS || 3;

  let lastStatus = 'UNKNOWN';

  for (let attempt = 0; attempt < NUMBER_OF_ATTEMPTS; attempt++) {
    const temps = [];
    const sampleStatuses = [];

    for (let sample = 0; sample < NUMBER_OF_SAMPLES; sample++) {
      const result = await readDS18B20Raw(sensorId);
      lastStatus = result.status;
      sampleStatuses.push(result.status);

      if (result.status === 'OK' && result.value !== null) {
        temps.push(result.value);
      } else {
        logger.warn(`Muestra descartada en sensor ${sensorId} debido a estado: ${result.status} (valor: ${result.value !== null ? result.value + '°C' : 'N/A'})`, 'HW');
      }

      if (sample < NUMBER_OF_SAMPLES - 1) {
        await new Promise(resolve => setTimeout(resolve, SAMPLE_DELAY_MS));
      }
    }

    if (temps.length > 0) {
      const medianTemp = getMedian(temps);
      if (medianTemp !== null) {
        const response = { success: true, temperature: parseFloat(medianTemp.toFixed(2)), status: 'OK' };
        tempCache[sensorId] = { timestamp: now, data: response };
        return response;
      }
    }

    // Determine representative status
    if (sampleStatuses.length > 0) {
      const counts = {};
      sampleStatuses.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
      delete counts['OK'];
      const nonOkStatuses = Object.keys(counts);
      if (nonOkStatuses.length > 0) {
        nonOkStatuses.sort((a, b) => counts[b] - counts[a]);
        lastStatus = nonOkStatuses[0];
      }
    }

    logger.warn(`Intento ${attempt + 1} de lectura del sensor 1-Wire ${sensorId} falló. Estado de diagnóstico: ${lastStatus}`, 'HW');
  }

  const response = { success: false, temperature: 999, status: lastStatus, msg: `Error, no temperature (sensor status: ${lastStatus})` };
  tempCache[sensorId] = { timestamp: now, data: response };
  return response;
}

/**
 * Reads selector switches.
 */
export function readSelectorPins() {
  if (isMockHardware) {
    return READ_PIN_SELECTORS.map((pin, index) => ({
      pin: pin,
      status: index % 2 === 0 ? 1 : 0
    }));
  }

  const result = [];
  READ_PIN_SELECTORS.forEach(pin => {
    let status = 0;
    let readSuccess = false;

    try {
      if (!selectorGpios[pin]) {
        selectorGpios[pin] = new Gpio(pin, 'in');
      }
      status = selectorGpios[pin].readSync();
      readSuccess = true;
    } catch (err) {
      if (selectorGpios[pin]) {
        try {
          selectorGpios[pin].unexport();
        } catch (unexportErr) { }
        delete selectorGpios[pin];
      }
    }

    if (!readSuccess) {
      let level = null;
      const execOpts = { encoding: 'utf-8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] };
      
      try {
        // 1. Try pinctrl (standard in Raspberry Pi OS Bookworm)
        try {
          const stdout = execSync(`pinctrl lev ${pin}`, execOpts);
          const val = parseInt(stdout.trim(), 10);
          if (!isNaN(val)) level = val;
        } catch {
          try {
            const stdout = execSync(`pinctrl get ${pin}`, execOpts);
            if (stdout.includes('hi') || stdout.includes('level 1') || stdout.includes('lev=1')) level = 1;
            else if (stdout.includes('lo') || stdout.includes('level 0') || stdout.includes('lev=0')) level = 0;
          } catch { }
        }

        // 2. Try gpioget (gpiod on Linux 6.x+)
        if (level === null) {
          try {
            const stdout = execSync(`gpioget 0 ${pin}`, execOpts);
            const val = parseInt(stdout.trim(), 10);
            if (!isNaN(val)) level = val;
          } catch {
            try {
              const stdout = execSync(`gpioget 4 ${pin}`, execOpts); // RPi 5 chip
              const val = parseInt(stdout.trim(), 10);
              if (!isNaN(val)) level = val;
            } catch { }
          }
        }

        // 3. Fallback: raspi-gpio (older Bullseye/Buster)
        if (level === null) {
          try {
            const stdout = execSync(`raspi-gpio get ${pin}`, execOpts);
            const match = stdout.match(/level=(\d)/);
            if (match) level = parseInt(match[1], 10);
          } catch { }
        }
      } catch { }

      if (level !== null) {
        status = level;
        readSuccess = true;
      }
    }

    if (readSuccess) {
      result.push({ pin: pin, status: status });
    } else {
      logger.debug(`No se pudo leer el pin selector ${pin} (onoff / CLI no disponibles)`, 'HW');
      result.push({ pin: pin, status: 0 });
    }
  });
  return result;
}

export function releaseSelectorPins() {
  Object.keys(selectorGpios).forEach(pin => {
    try {
      selectorGpios[pin].unexport();
    } catch (err) {
      logger.error(`Fallo al liberar/desexportar el pin selector en caché ${pin}`, err, 'HW');
    }
    delete selectorGpios[pin];
  });
}

/**
 * Returns disk space.
 */
export function getDiskSpace() {
  return new Promise(resolve => {
    if (isMockHardware) {
      return resolve({
        usedspace: 14.2,
        freespace: 16.5,
        totalspace: 30.7
      });
    }

    exec("df -k /", (err, stdout, stderr) => {
      const fallback = { usedspace: 0, freespace: 0, totalspace: 0 };
      if (err || !stdout) {
        logger.error(`Error al ejecutar el comando df: ${stderr || err.message}`, null, 'HW');
        return resolve(fallback);
      }

      try {
        const lines = stdout.trim().split('\n');
        if (lines.length < 2) return resolve(fallback);

        const parts = lines[1].replace(/\s+/g, ' ').split(' ');
        if (parts.length >= 4) {
          const totalKB = parseFloat(parts[1]);
          const usedKB = parseFloat(parts[2]);
          const freeKB = parseFloat(parts[3]);

          const totalGB = parseFloat((totalKB / 1024.0 / 1024.0).toFixed(2));
          const usedGB = parseFloat((usedKB / 1024.0 / 1024.0).toFixed(2));
          const freeGB = parseFloat((freeKB / 1024.0 / 1024.0).toFixed(2));

          return resolve({
            usedspace: usedGB,
            freespace: freeGB,
            totalspace: totalGB
          });
        }
      } catch (parseErr) {
        logger.error('Error al analizar la salida del comando df', parseErr, 'HW');
      }
      resolve(fallback);
    });
  });
}

export default {
  isMockHardware,
  GpioRelay,
  getTemperature,
  readSelectorPins,
  releaseSelectorPins,
  getDiskSpace
};
