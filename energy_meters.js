/**
 * Energy Meters Modbus RTU Acquisition Module
 * 
 * Handles Modbus RTU communication with energy meters (UPM309, UEM1P5, MFM384, etc.)
 * over RS485 serial ports with concurrency lock.
 */
import fs from 'fs';
import logger from './logger.js';
import { withSerialLock } from './modbus_honeywell.js';

let Modbus = null;
let SerialPort = null;
let isModbusAvailable = false;

try {
  // Dynamic import since these are optional/platform-specific dependencies
  Modbus = await import('jsmodbus');
  const serialportModule = await import('serialport');
  SerialPort = serialportModule.SerialPort;
  isModbusAvailable = true;
} catch (e) {
  logger.warn('Modbus o SerialPort no están instalados. El módulo de medidores correrá en modo SIMULADO.', 'ENERGY');
}

// Float decoding from two 16-bit registers (IEEE 754 single precision)
export function decodeFloat(high16, low16) {
  if (high16 === 0 && low16 === 0) return 0;
  try {
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(high16, 0);
    buf.writeUInt16BE(low16, 2);
    const val = buf.readFloatBE(0);
    return Number.isFinite(val) ? Math.round(val * 10000) / 10000 : 0;
  } catch (err) {
    return 0;
  }
}

// Device profiles containing register maps and read methods
export const PROFILES = {
  UEM1P5: {
    readMethod: 'holding',
    registers: [
      { name: 'Volts', address: 0x1000, count: 14 },
      { name: 'Current', address: 0x100E, count: 10 },
      { name: 'PF', address: 0x1018, count: 8 },
      { name: 'Power', address: 0x1020, count: 8 },
      { name: 'APower', address: 0x1028, count: 8 },
      { name: 'RPower', address: 0x1030, count: 8 },
      { name: 'F', address: 0x1038, count: 2 },
      { name: 'KWH', address: 0x1100, count: 16 }
    ]
  },
  MFM384_R_C: {
    readMethod: 'input',
    registers: [
      { name: 'V1N', address: 0x01, count: 2 },
      { name: 'V2N', address: 0x03, count: 2 },
      { name: 'V3N', address: 0x05, count: 2 },
      { name: 'VN', address: 0x07, count: 2 },
      { name: 'V12', address: 0x09, count: 2 },
      { name: 'V23', address: 0x0b, count: 2 },
      { name: 'V31', address: 0x0d, count: 2 },
      { name: 'VLL', address: 0x0f, count: 2 },
      { name: 'I1', address: 0x11, count: 2 },
      { name: 'I2', address: 0x13, count: 2 },
      { name: 'I3', address: 0x15, count: 2 },
      { name: 'I', address: 0x17, count: 2 },
      { name: 'KW1', address: 0x19, count: 2 },
      { name: 'KW2', address: 0x1b, count: 2 },
      { name: 'KW3', address: 0x1d, count: 2 },
      { name: 'KW', address: 0x2b, count: 2 },
      { name: 'PF1', address: 0x31, count: 2 },
      { name: 'PF2', address: 0x33, count: 2 },
      { name: 'PF3', address: 0x35, count: 2 },
      { name: 'PF', address: 0x37, count: 2 },
      { name: 'Frequency', address: 0x39, count: 2 },
      { name: 'KVAr1', address: 0x25, count: 2 },
      { name: 'KVAr2', address: 0x27, count: 2 },
      { name: 'KVAr3', address: 0x29, count: 2 }
    ]
  },
  MFM383A: {
    // Uses the same register layout as MFM384_R_C
    readMethod: 'input',
    registers: [
      { name: 'V1N', address: 0x01, count: 2 },
      { name: 'V2N', address: 0x03, count: 2 },
      { name: 'V3N', address: 0x05, count: 2 },
      { name: 'VN', address: 0x07, count: 2 },
      { name: 'V12', address: 0x09, count: 2 },
      { name: 'V23', address: 0x0b, count: 2 },
      { name: 'V31', address: 0x0d, count: 2 },
      { name: 'VLL', address: 0x0f, count: 2 },
      { name: 'I1', address: 0x11, count: 2 },
      { name: 'I2', address: 0x13, count: 2 },
      { name: 'I3', address: 0x15, count: 2 },
      { name: 'I', address: 0x17, count: 2 },
      { name: 'KW1', address: 0x19, count: 2 },
      { name: 'KW2', address: 0x1b, count: 2 },
      { name: 'KW3', address: 0x1d, count: 2 },
      { name: 'KW', address: 0x2b, count: 2 },
      { name: 'PF1', address: 0x31, count: 2 },
      { name: 'PF2', address: 0x33, count: 2 },
      { name: 'PF3', address: 0x35, count: 2 },
      { name: 'PF', address: 0x37, count: 2 },
      { name: 'Frequency', address: 0x39, count: 2 },
      { name: 'KVAr1', address: 0x25, count: 2 },
      { name: 'KVAr2', address: 0x27, count: 2 },
      { name: 'KVAr3', address: 0x29, count: 2 }
    ]
  },
  UPM309: {
    readMethod: 'holding',
    registers: [
      { name: 'Volts', address: 0x1000, count: 14 },
      { name: 'Current', address: 0x100E, count: 10 },
      { name: 'Power', address: 0x1018, count: 8 },
      { name: 'APower', address: 0x1020, count: 8 },
      { name: 'RPower', address: 0x1028, count: 8 },
      { name: 'PF', address: 0x1030, count: 8 },
      { name: 'DPF', address: 0x1038, count: 6 },
      { name: 'TAN', address: 0x103E, count: 8 },
      { name: 'THD', address: 0x1046, count: 20 },
      { name: 'F', address: 0x105A, count: 2 },
      { name: 'KWH', address: 0x1400, count: 18 },
      { name: 'HaV1', address: 0x1500, count: 32 },
      { name: 'HaV2', address: 0x1520, count: 32 },
      { name: 'HaV3', address: 0x1540, count: 32 },
      { name: 'HaV12', address: 0x1560, count: 32 },
      { name: 'HaV32', address: 0x1580, count: 32 },
      { name: 'HaV31', address: 0x15A0, count: 32 },
      { name: 'HaA1', address: 0x15C0, count: 32 },
      { name: 'HaA2', address: 0x15E0, count: 32 },
      { name: 'HaA3', address: 0x1600, count: 32 },
      { name: 'HaAN', address: 0x1620, count: 32 }
    ]
  }
};

/**
 * Reads a single device's Modbus registers and decodes them with timeout protection.
 */
async function readDeviceModbus(client, profile, slaveId, serialport = null) {
  const data = {};
  
  if (!profile.registers || profile.registers.length === 0) return data;

  // Sonda rápida preliminar: verificar que el esclavo responde antes de iterar todo el perfil.
  // Evita retener el candado del bus por más de 100 segundos si un medidor está apagado.
  const probeItem = profile.registers[0];
  try {
    const probePromise = profile.readMethod === 'holding'
      ? client.readHoldingRegisters(probeItem.address, probeItem.count)
      : client.readInputRegisters(probeItem.address, probeItem.count);
    const probeTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout en sonda rápida preliminar')), 900)
    );
    const probeRes = await Promise.race([probePromise, probeTimeout]);
    if (!probeRes || !probeRes.response) {
      logger.warn(`[Fast-Fail] Esclavo ${slaveId} no devolvió respuesta válida en sonda preliminar. Omitiendo perfil completo.`, 'ENERGY');
      if (serialport && typeof serialport.flush === 'function') {
        try { serialport.flush(); } catch {}
      }
      return null;
    }
  } catch (probeErr) {
    logger.warn(`[Fast-Fail] Medidor esclavo ${slaveId} no responde al sondeo inicial (${probeErr.message}). Omitiendo lectura para evitar bloqueo del bus RS-485.`, 'ENERGY');
    if (serialport && typeof serialport.flush === 'function') {
      try { serialport.flush(); } catch {}
    }
    return null;
  }

  for (const item of profile.registers) {
    // Brief sleep to avoid overloading RS485 bus
    await new Promise(resolve => setTimeout(resolve, 50));
    
    let success = false;
    let lastError = null;
    
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const readPromise = profile.readMethod === 'holding'
          ? client.readHoldingRegisters(item.address, item.count)
          : client.readInputRegisters(item.address, item.count);
        
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout de lectura en registro ${item.name}`)), 2500)
        );

        const response = await Promise.race([readPromise, timeoutPromise]);
        
        if (response && response.response && response.response.body && response.response.body.valuesAsArray) {
          const rawRegisters = response.response.body.valuesAsArray;
          const floats = [];
          
          // Decode registers in pairs
          for (let i = 1; i < rawRegisters.length; i += 2) {
            const high = rawRegisters[i - 1];
            const low = rawRegisters[i];
            floats.push(decodeFloat(high, low));
          }
          
          data[item.name] = floats;
          success = true;
          break;
        } else {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err) {
        lastError = err;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    if (!success) {
      logger.warn(`Fallo al leer registro ${item.name} en esclavo ${slaveId}: ${lastError ? lastError.message : 'Sin datos'}`, 'ENERGY');
    }
  }
  
  return data;
}

/**
 * Generates mock data for simulation mode.
 */
function generateMockData(profileName) {
  const data = {};
  const isUpm309OrUem = profileName === 'UPM309' || profileName === 'UEM1P5';
  
  if (isUpm309OrUem) {
    data['Volts'] = [120.5 + Math.random(), 120.2 + Math.random(), 120.7 + Math.random(), 208.4 + Math.random(), 208.1 + Math.random(), 208.9 + Math.random(), 120.4 + Math.random()];
    data['Current'] = [10.5 + Math.random() * 5, 11.2 + Math.random() * 5, 9.8 + Math.random() * 5, 0.5, 10.5];
    data['Power'] = [1200 + Math.random() * 200, 1300 + Math.random() * 200, 1100 + Math.random() * 200, 3600 + Math.random() * 600];
    data['APower'] = [1250 + Math.random() * 200, 1350 + Math.random() * 200, 1150 + Math.random() * 200, 3750 + Math.random() * 600];
    data['RPower'] = [300 + Math.random() * 50, 320 + Math.random() * 50, 280 + Math.random() * 50, 900 + Math.random() * 150];
    data['PF'] = [0.96, 0.96, 0.95, 0.96];
    data['F'] = [60.0 + (Math.random() - 0.5) * 0.05];
    
    // Accumulating energy counter (Wh)
    const baseKwh = 12543000 + Math.round(Date.now() / 10000); 
    data['KWH'] = [baseKwh, 0, baseKwh + 1000, 0, baseKwh + 2000, 0, baseKwh * 3, 0, baseKwh * 3];
  } else {
    // MFM384 / MFM383A flat structure
    data['V1N'] = [120.4 + Math.random()];
    data['V2N'] = [120.1 + Math.random()];
    data['V3N'] = [120.6 + Math.random()];
    data['VN'] = [120.3 + Math.random()];
    data['V12'] = [208.3 + Math.random()];
    data['V23'] = [208.0 + Math.random()];
    data['V31'] = [208.8 + Math.random()];
    data['VLL'] = [208.4 + Math.random()];
    data['I1'] = [8.5 + Math.random() * 3];
    data['I2'] = [9.2 + Math.random() * 3];
    data['I3'] = [7.8 + Math.random() * 3];
    data['I'] = [8.5 + Math.random() * 3];
    data['KW1'] = [0.95 + Math.random() * 0.3];
    data['KW2'] = [1.02 + Math.random() * 0.3];
    data['KW3'] = [0.88 + Math.random() * 0.3];
    data['KW'] = [2.85 + Math.random() * 0.9];
    data['PF1'] = [0.95];
    data['PF2'] = [0.96];
    data['PF3'] = [0.94];
    data['PF'] = [0.95];
    data['Frequency'] = [60.0 + (Math.random() - 0.5) * 0.05];
  }
  
  return data;
}

/**
 * Main function to read all energy meters from the manifest with serial port locking.
 */
export async function readAllMeters(devices) {
  const energyDevices = devices.filter(d => d.type === 'energy_meter');
  if (energyDevices.length === 0) {
    return [];
  }
  
  logger.info(`Iniciando lectura de ${energyDevices.length} medidores de energía...`, 'ENERGY');
  
  const results = [];
  
  // Check if we should run in mock mode
  const forceMock = process.env.HARDWARE_MODE === 'MOCK' || process.platform === 'win32';
  
  if (forceMock || !isModbusAvailable) {
    logger.debug('Ejecutando lectura de medidores en modo SIMULADO.', 'ENERGY');
    for (const dev of energyDevices) {
      const profileName = dev.config?.model || dev.config?.meterModel || 'UPM309';
      const mockData = generateMockData(profileName);
      results.push({
        deviceId: dev.id,
        esmM: dev.esmM,
        externalId: dev.externalId,
        data: mockData
      });
      logger.info(`[SIMULACIÓN] Medidor ${dev.name} (esmM: ${dev.esmM}) leído con éxito.`, 'ENERGY');
    }
    return results;
  }
  
  // Real Modbus RTU execution with port discovery and explicit configuration precedence
  const configuredPort = process.env.ENERGY_SERIAL_PORT || energyDevices.find(d => d.config?.serialPort || d.config?.port)?.config?.serialPort;
  let primaryPort = configuredPort;

  if (!primaryPort) {
    let ports = [];
    try {
      ports = fs.readdirSync('/dev')
        .filter(file => file.startsWith('ttyUSB') || file.startsWith('ttyACM'))
        .map(file => `/dev/${file}`)
        .sort();
    } catch (err) {
      logger.warn(`Error al leer el directorio /dev: ${err.message}`, 'ENERGY');
    }
    
    if (ports.length === 0) {
      logger.warn('No se encontraron puertos seriales (/dev/ttyUSB* o /dev/ttyACM*).', 'ENERGY');
      return [];
    }

    primaryPort = ports[0];
  }

  return await withSerialLock(primaryPort, async () => {
    let serialport = null;
    let client = null;

    try {
      logger.info(`Conectando puerto serial Modbus bajo bloqueo: ${primaryPort}...`, 'ENERGY');
      serialport = new SerialPort({
        path: primaryPort,
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false
      });

      const opened = await new Promise((resolve) => {
        serialport.open((err) => {
          if (err) {
            logger.debug(`Error al abrir puerto ${primaryPort}: ${err.message}`, 'ENERGY');
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });

      if (!opened) {
        logger.warn(`No se pudo abrir ${primaryPort} para medidores.`, 'ENERGY');
        return [];
      }

      const RTUClient = Modbus.client?.RTU || Modbus.default?.client?.RTU || Modbus.client;
      client = new RTUClient(serialport, 1);

      for (const dev of energyDevices) {
        const profileName = dev.config?.model || dev.config?.meterModel || 'UPM309';
        const profile = PROFILES[profileName] || PROFILES.UPM309;
        const slaveId = dev.config?.slaveId || dev.config?.unit || dev.config?.address || 1;
        
        logger.info(`Leyendo medidor ${dev.name} (Modelo: ${profileName}, Esclavo: ${slaveId})...`, 'ENERGY');
        client.setID(slaveId);
        
        try {
          const readings = await readDeviceModbus(client, profile, slaveId, serialport);
          if (readings && Object.keys(readings).length > 0) {
            results.push({
              deviceId: dev.id,
              esmM: dev.esmM,
              externalId: dev.externalId,
              data: readings
            });
            logger.success(`Medidor ${dev.name} (esmM: ${dev.esmM}) leído con éxito.`, 'ENERGY');
          } else {
            logger.warn(`No se obtuvieron datos para el medidor ${dev.name} (esmM: ${dev.esmM}).`, 'ENERGY');
          }
        } catch (devErr) {
          logger.error(`Error leyendo dispositivo ${dev.name}:`, devErr, 'ENERGY');
        }
      }
    } catch (err) {
      logger.error('Error general durante la lectura de medidores:', err, 'ENERGY');
    } finally {
      if (serialport && serialport.isOpen) {
        await new Promise((resolve) => {
          try {
            serialport.close(() => resolve());
          } catch {
            resolve();
          }
        });
      }
    }

    return results;
  });
}

export default {
  decodeFloat,
  PROFILES,
  readAllMeters
};
