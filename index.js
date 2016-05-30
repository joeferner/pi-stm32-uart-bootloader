var wpi = require('wiring-pi');
var serialPort = require("serialport");
var SerialPort = serialPort.SerialPort;
var async = require('async');

const BOOT0_MAIN_FLASH = 0;
const BOOT0_SYSTEM_MEMORY = 1;

class STM32USARTBootloader {
  constructor(options) {
    this.resetPin = options.resetPin;
    this.boot0Pin = options.boot0Pin;
    this.serialPortPath = options.serialPortPath;
    this.serialPortBaudRate = options.serialPortBaudRate || 57600;

    wpi.pinMode(this.boot0Pin, wpi.OUTPUT);
    wpi.pinMode(this.resetPin, wpi.OUTPUT);
    
    async.series([
      this._setBoot0MainFlash.bind(this),
      this._deassertReset.bind(this)
    ], (err) => {
      if (err) {
        console.error('could not initialize', err);
      }
    });
  }

  _setBoot0MainFlash(callback) {
    wpi.digitalWrite(this.boot0Pin, BOOT0_MAIN_FLASH);
    callback();
  }

  _setBoot0SystemMemory(callback) {
    wpi.digitalWrite(this.boot0Pin, BOOT0_SYSTEM_MEMORY);
    callback();
  }

  _deassertReset(callback) {
    wpi.digitalWrite(this.resetPin, 0);
    setTimeout(callback, 1);
  }

  _assertReset(callback) {
    wpi.digitalWrite(this.resetPin, 1);
    setTimeout(callback, 1);
  }

  _openSerialPort(callback) {
    this.serialPort = new SerialPort(this.serialPortPath, {
      baudrate: this.serialPortBaudRate,
      dataBits: 7,
      parity: 'even',
      stopBits: 1,
      parser: serialPort.parsers.raw
    }, false);
    this.serialPort.open(callback);
  }

  _closeSerialPort(callback) {
    this.serialPort.removeAllListeners('data');
    this.serialPort.close((err) => {
      this.serialPort = null;
      callback(err);
    });
  }

  flash(fileName, callback) {
    this._runSystemMemoryFn((callback) => {
      // TODO
      console.log('flash');
      return callback();
    }, callback);
  }

  _enterBootloader(callback) {
    var timeout = setTimeout(() => {
      this.serialPort.removeAllListeners('data');
      if (callback) {
        callback(new Error('Enter Bootloader: Timeout waiting for response to enter bootloader'));
      }
    }, 1000);
    this.serialPort.once('data', (data) => {
      clearTimeout(timeout);
      console.error(data);
      if (data.length != 1) {
        return callback(new Error('Enter Bootloader: Expected length 1 found ' + data.length));
      }
      if (data[0] != 0x79) {
        return callback(new Error('Enter Bootloader: Expected 0x79 found 0x' + data[0].toString(16)));
      }
      return callback();
    });
    this.serialPort.write(new Buffer([0x7f]), (err) => {
      clearTimeout(timeout);
      if (err) {
        this.serialPort.removeAllListeners('data');
        return callback(err);
      }
    });
  }

  _runSystemMemoryFn(fn, callback) {
    async.series([
      this._openSerialPort.bind(this),
      this._assertReset.bind(this),
      this._setBoot0SystemMemory.bind(this),
      this._deassertReset.bind(this),
      this._enterBootloader.bind(this),
      fn
    ], (err) => {
      async.series([
        this._assertReset.bind(this),
        this._setBoot0MainFlash.bind(this),
        this._closeSerialPort.bind(this),
        this._deassertReset.bind(this)
      ], (innerErr) => {
        if (innerErr) {
          return callback(innerErr);
        }
        if (err) {
          return callback(err);
        }
        return callback();
     });
    });
  }
}

module.exports = STM32USARTBootloader;
