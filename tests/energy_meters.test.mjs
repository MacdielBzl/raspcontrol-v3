import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real acquisition module with a serial transport fixture, even on Windows.
test('skips an unresponsive slave before reading two addresses on the shared port', async () => {
  const ports = [];
  const errors = [];
  let pendingRequests = 0;
  const context = vm.createContext({
    Buffer, process: { platform: 'linux', env: { ENERGY_SERIAL_PORT: '/dev/test' } },
    setTimeout: (fn, delay) => {
      const timer = setTimeout(fn, delay < 900 ? 0 : delay);
      if (delay >= 900) timer.unref();
      return timer;
    },
  });
  class SerialPort extends EventEmitter {
    constructor() { super(); ports.push(this); }
    open(callback) { this.isOpen = true; callback(); }
    close(callback) { this.isOpen = false; callback(); }
  }
  class RTU {
    constructor(port, address, timeout = 5000) {
      this.address = address;
      this.timeout = timeout;
      port.on('data', this.onData = () => {});
      port.on('open', this.onOpen = () => {});
    }
    async readHoldingRegisters() {
      if (this.address === 3) {
        pendingRequests++;
        return new Promise((_, reject) => setTimeout(() => {
          pendingRequests--;
          reject(new Error('Slave timeout'));
        }, this.timeout));
      }
      assert.equal(pendingRequests, 0, 'Previous slave still has active requests');
      // Different float readings prove that acquisition selects the right slave.
      const buffer = Buffer.alloc(4);
      buffer.writeFloatBE(this.address === 1 ? 120 : 240);
      return { response: { body: { valuesAsArray: [buffer.readUInt16BE(0), buffer.readUInt16BE(2)] } } };
    }
  }
  function synthetic(exports) {
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  }
  const modules = {
    fs: synthetic({ default: {} }),
    './logger.js': synthetic({ default: {
      info() {}, debug() {}, warn() {}, success() {}, error(...args) { errors.push(args); },
    } }),
    './modbus_honeywell.js': synthetic({ withSerialLock: async (_path, task) => task() }),
    jsmodbus: synthetic({ client: { RTU } }),
    serialport: synthetic({ SerialPort }),
  };
  const source = await readFile(new URL('../energy_meters.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically: async (specifier) => {
      const dependency = modules[specifier];
      if (dependency.status === 'unlinked') await dependency.link(() => {});
      if (dependency.status === 'linked') await dependency.evaluate();
      return dependency;
    },
  });
  await module.link((specifier) => modules[specifier]);
  await module.evaluate();
  module.namespace.PROFILES.UPM309.registers = [{ name: 'Volts', address: 0x1000, count: 2 }];
  const results = await module.namespace.readAllMeters([
    { id: 'offline', name: 'Offline', type: 'energy_meter', config: { slaveId: 3 } },
    { id: 'first', name: 'First', type: 'energy_meter', config: { slaveId: 1 } },
    { id: 'second', name: 'Second', type: 'energy_meter', config: { slaveId: 2 } },
  ]);
  assert.equal(results.length, 2, errors.map(args => args.map(arg => arg?.message || arg).join(' ')).join('\n'));
  assert.equal(results[0].deviceId, 'first');
  assert.equal(results[0].data.Volts[0], 120);
  assert.equal(results[1].deviceId, 'second');
  assert.equal(results[1].data.Volts[0], 240);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].isOpen, false);
  assert.equal(ports[0].listenerCount('data'), 0);
  assert.equal(ports[0].listenerCount('open'), 0);
  assert.equal(errors.length, 0);
});
