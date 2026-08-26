/**
 * Honeywell Thermostat Modbus RTU/TCP Controller (ESM Version)
 * 
 * Permite usar el termostato Honeywell como un sensor de temperatura
 * y como actuador (forzar encendido/apagado de compresores o cambiar setpoint)
 * soportando Modbus TCP (red) y Modbus RTU (Puerto Serie RS485).
 */
import net from 'net';

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
  // Silent fallback to Mock mode if packages are not installed or compiled on this host
}

// Configuración de registros estándar Honeywell Modbus
export const REGISTERS = {
  ROOM_TEMP: 0x0066,       // Temperatura ambiente (Input/Holding Register - Generalmente en décimas 235 = 23.5°C)
  SYSTEM_MODE: 0x0067,     // Modo de Clima (0 = Off, 1 = Heat, 2 = Cool, 3 = Auto)
  FAN_MODE: 0x0068,        // Modo de Ventilador (0 = Auto, 1 = On)
  COOL_SETPOINT: 0x0069,   // Setpoint para enfriamiento
  HEAT_SETPOINT: 0x006A,   // Setpoint para calefacción
  RELAY_STATUS: 0x0070     // Estado físico de relevadores (Modbus Coil o Holding Register)
};

/**
 * Cliente Modbus TCP Honeywell
 */
export class HoneywellModbusTCPClient {
  constructor(host, port = 502, unitId = 1) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.socket = null;
    this.client = null;
  }

  async connect() {
    if (!isModbusAvailable || process.platform === 'win32') return true;
    
    // Si la conexión ya existe y es válida, la reutilizamos
    if (this.socket && this.client && !this.socket.destroyed && this.socket.writable) {
      return true;
    }
    
    this.cleanup();

    return new Promise((resolve, reject) => {
      let finished = false;
      this.socket = new net.Socket();

      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          this.cleanup();
          reject(new Error(`Timeout de conexión Modbus TCP a ${this.host}:${this.port}`));
        }
      }, 4000);
      
      const TCPClient = Modbus.client?.TCP || Modbus.default?.client?.TCP || Modbus.client;
      this.client = new TCPClient(this.socket, this.unitId);

      this.socket.on('connect', () => {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          resolve(true);
        }
      });

      this.socket.on('error', (err) => {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          this.cleanup();
          reject(err);
        }
      });

      this.socket.connect({ host: this.host, port: this.port });
    });
  }

  cleanup() {
    if (this.socket) {
      try { 
        this.socket.removeAllListeners();
        this.socket.destroy(); 
      } catch (e) {}
    }
    this.socket = null;
    this.client = null;
  }

  async readTemperature() {
    if (!isModbusAvailable || process.platform === 'win32') {
      return 22.0 + Math.random() * 2.0;
    }

    try {
      await this.connect();
      const readPromise = this.client.readHoldingRegisters(REGISTERS.ROOM_TEMP, 1);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout de lectura de registros Modbus TCP')), 3000)
      );

      const response = await Promise.race([readPromise, timeoutPromise]);

      if (response && response.response && response.response.body && response.response.body.valuesAsArray.length > 0) {
        return response.response.body.valuesAsArray[0] / 10.0;
      }
      throw new Error('No data received');
    } catch (err) {
      this.cleanup(); // Liberar socket dañado para forzar reconexión la próxima vez
      console.error(`[Error Modbus TCP] Fallo al leer la temperatura desde ${this.host}:`, err.message);
      return 999;
    }
  }

  async writeSystemMode(isOn) {
    const mode = isOn ? 2 : 0;
    if (!isModbusAvailable || process.platform === 'win32') {
      console.log(`[SIMULACIÓN Modbus TCP] Escribiendo modo de sistema (SYSTEM_MODE) a ${mode} en ${this.host}`);
      return true;
    }

    try {
      await this.connect();
      const writePromise = this.client.writeSingleRegister(REGISTERS.SYSTEM_MODE, mode);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout de escritura Modbus TCP')), 3000)
      );

      await Promise.race([writePromise, timeoutPromise]);
      return true;
    } catch (err) {
      this.cleanup(); // Liberar socket dañado
      console.error(`[Error Modbus TCP] Fallo al escribir el modo de sistema en ${this.host}:`, err.message);
      return false;
    }
  }
}

/**
 * Cliente Modbus RTU Honeywell (Puerto Serie RS485)
 * Espera una configuración en formato: "/dev/ttyUSB0:1" (puerto:slaveId)
 */
export class HoneywellModbusRTUClient {
  constructor(connectionString) {
    const parts = connectionString.split(':');
    this.path = parts[0]; // ej: /dev/ttyUSB0
    this.slaveId = parts.length > 1 ? parseInt(parts[1], 10) : 1;
    this.serialport = null;
    this.client = null;
  }

  async connect() {
    if (!isModbusAvailable || process.platform === 'win32') return true;
    
    // Si el puerto serie ya está abierto, lo reutilizamos
    if (this.serialport && this.serialport.isOpen) {
      return true;
    }
    
    this.cleanup();

    return new Promise((resolve, reject) => {
      let finished = false;
      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          this.cleanup();
          reject(new Error(`Timeout de conexión Modbus RTU en ${this.path}`));
        }
      }, 4000);

      try {
        this.serialport = new SerialPort({
          path: this.path,
          baudRate: 9600,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          autoOpen: false
        });

        const RTUClient = Modbus.client?.RTU || Modbus.default?.client?.RTU || Modbus.client;
        this.client = new RTUClient(this.serialport, this.slaveId);

        this.serialport.open((err) => {
          if (!finished) {
            finished = true;
            clearTimeout(timeout);
            if (err) {
              this.cleanup();
              reject(err);
            } else {
              resolve(true);
            }
          }
        });
      } catch (err) {
        if (!finished) {
          finished = true;
          clearTimeout(timeout);
          reject(err);
        }
      }
    });
  }

  cleanup() {
    if (this.serialport) {
      if (this.serialport.isOpen) {
        try { this.serialport.close(); } catch (e) {}
      }
    }
    this.serialport = null;
    this.client = null;
  }

  async readTemperature() {
    if (!isModbusAvailable || process.platform === 'win32') {
      return 21.0 + Math.random() * 3.0;
    }

    try {
      await this.connect();
      const readPromise = this.client.readHoldingRegisters(REGISTERS.ROOM_TEMP, 1);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout de lectura Modbus RTU')), 3000)
      );

      const response = await Promise.race([readPromise, timeoutPromise]);

      if (response && response.response && response.response.body && response.response.body.valuesAsArray.length > 0) {
        return response.response.body.valuesAsArray[0] / 10.0;
      }
      throw new Error('No data received');
    } catch (err) {
      this.cleanup(); // Liberar puerto serie dañado
      console.error(`[Error Modbus RTU] Fallo al leer la temperatura desde ${this.path} (Esclavo ${this.slaveId}):`, err.message);
      return 999;
    }
  }

  async writeSystemMode(isOn) {
    const mode = isOn ? 2 : 0;
    if (!isModbusAvailable || process.platform === 'win32') {
      console.log(`[SIMULACIÓN Modbus RTU] Escribiendo modo de sistema (SYSTEM_MODE) a ${mode} en ${this.path} (Esclavo ${this.slaveId})`);
      return true;
    }

    try {
      await this.connect();
      const writePromise = this.client.writeSingleRegister(REGISTERS.SYSTEM_MODE, mode);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout de escritura Modbus RTU')), 3000)
      );

      await Promise.race([writePromise, timeoutPromise]);
      return true;
    } catch (err) {
      this.cleanup(); // Liberar puerto serie dañado
      console.error(`[Error Modbus RTU] Fallo al escribir el modo de sistema en ${this.path}:`, err.message);
      return false;
    }
  }
}

// Pool de conexiones/clientes persistentes para evitar sobrecarga
const tcpClientsPool = {};
const rtuClientsPool = {};

export function getModbusTCPClient(host, port = 502, unitId = 1) {
  const key = `${host}:${port}:${unitId}`;
  if (!tcpClientsPool[key]) {
    tcpClientsPool[key] = new HoneywellModbusTCPClient(host, port, unitId);
  }
  return tcpClientsPool[key];
}

export function getModbusRTUClient(connectionString) {
  if (!rtuClientsPool[connectionString]) {
    rtuClientsPool[connectionString] = new HoneywellModbusRTUClient(connectionString);
  }
  return rtuClientsPool[connectionString];
}

export default {
  isModbusAvailable,
  HoneywellModbusTCPClient,
  HoneywellModbusRTUClient,
  getModbusTCPClient,
  getModbusRTUClient,
  REGISTERS
};
