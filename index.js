var wpi = require('wiring-pi');
var serialPort = require("serialport");
var SerialPort = serialPort.SerialPort;
var async = require('async');
var BufferBuilder = require('buffer-builder');
var fs = require('fs');

const BOOT0_MAIN_FLASH = 0;
const BOOT0_SYSTEM_MEMORY = 1;

const WRITE_PACKET_SIZE = 256;

const CMD_GET = 0x00;
const CMD_GET_VERSION = 0x01;
const CMD_ID = 0x02;
const CMD_READ_MEMORY = 0x11;
const CMD_GO = 0x21;
const CMD_WRITE_MEMORY = 0x31;
const CMD_ERASE = 0x43;
const CMD_EXTENDED_ERASE = 0x44;
const CMD_WRITE_PROTECT = 0x63;
const CMD_WRITE_UNPROTECT = 0x73;
const CMD_READOUT_PROTECT = 0x82;
const CMD_READOUT_UNPROTECT = 0x92;

const ACK = 0x79;
const NACK = 0x1f;

class STM32USARTBootloader {
    constructor(options) {
        this._resetPin = options.resetPin;
        this._boot0Pin = options.boot0Pin;
        this._serialPortPath = options.serialPortPath;
        this._serialPortBaudRate = options.serialPortBaudRate || 9600;

        wpi.pinMode(this._boot0Pin, wpi.OUTPUT);

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
        wpi.digitalWrite(this._boot0Pin, BOOT0_MAIN_FLASH);
        callback();
    }

    _setBoot0SystemMemory(callback) {
        wpi.digitalWrite(this._boot0Pin, BOOT0_SYSTEM_MEMORY);
        callback();
    }

    _deassertReset(callback) {
        wpi.digitalWrite(this._resetPin, 1);
        wpi.pinMode(this._resetPin, wpi.OUTPUT);
        callback();
    }

    _assertReset(callback) {
        wpi.digitalWrite(this._resetPin, 0);
        wpi.pinMode(this._resetPin, wpi.INPUT);
        callback();
    }

    _openSerialPort(callback) {
        this._serialPort = new SerialPort(this._serialPortPath, {
            baudrate: this._serialPortBaudRate,
            dataBits: 8,
            parity: 'even',
            stopBits: 1,
            parser: serialPort.parsers.raw
        }, false);
        this._serialPort.open(callback);
    }

    _closeSerialPort(callback) {
        this._serialPort.removeAllListeners('data');
        this._serialPort.close((err) => {
            this._serialPort = null;
            callback(err);
        });
    }

    static _calculateChecksumOfBuffer(buffer) {
        var checksum = 0x00;
        for (var i = 0; i < buffer.length; i++) {
            checksum = checksum ^ buffer[i];
        }
        return checksum;
    }

    _cmdWrite(address, data, callback) {
        console.log('write length: ' + data.length + ', address: 0x' + address.toString(16));
        const STATE = {
            SEND_ADDRESS: 0,
            SEND_DATA: 1,
            WAIT_FOR_DATA_ACK: 2,
            COMPLETE: 3,
            ERROR: 4
        };

        var addr0 = (address >> 24) & 0xff;
        var addr1 = (address >> 16) & 0xff;
        var addr2 = (address >> 8) & 0xff;
        var addr3 = (address >> 0) & 0xff;
        var addrChecksum = addr0 ^ addr1 ^ addr2 ^ addr3;
        var buffer;
        var state = STATE.SEND_ADDRESS;
        if (!this._cmdIsAvailable(CMD_WRITE_MEMORY)) {
            return callback(new Error('write memory command not available'));
        }
        this._withTimeoutAndData(
            (callback) => {
                this._serialPort.write(new Buffer([CMD_WRITE_MEMORY, ~CMD_WRITE_MEMORY]), callback);
            },
            (rx, callback) => {
                switch (state) {
                    case STATE.SEND_ADDRESS:
                        if (rx[0] != ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.SEND_DATA;
                        buffer = new Buffer([addr0, addr1, addr2, addr3, addrChecksum]);
                        return this._serialPort.write(buffer, (err) => {
                            if (err) {
                                return callback(err);
                            }
                        });

                    case STATE.SEND_DATA:
                        if (rx[0] != ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected address ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.WAIT_FOR_DATA_ACK;
                        buffer = Buffer.alloc(1 + data.length + 1);
                        buffer[0] = data.length - 1;
                        data.copy(buffer, 1, 0);
                        buffer[buffer.length - 1] = buffer[0] ^ STM32USARTBootloader._calculateChecksumOfBuffer(data);
                        return this._serialPort.write(buffer, (err) => {
                            if (err) {
                                return callback(err);
                            }
                        });

                    case STATE.WAIT_FOR_DATA_ACK:
                        if (rx[0] != ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected data ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.COMPLETE;
                        return callback();
                }
            },
            30 * 1000,
            callback
        );
    }

    _writeAll(startAddress, data, callback) {
        console.log('write length: ' + data.length + ', startAddress: 0x' + startAddress.toString(16));
        var address = startAddress;
        var offset = 0;
        var length = data.length + (4 - (data.length % 4));
        async.whilst(
            () => {
                return offset < length;
            },
            (callback) => {
                var packet = Buffer.alloc(WRITE_PACKET_SIZE, 0xff);
                data.copy(packet, 0, offset);
                this._cmdWrite(address, packet, (err) => {
                    if (err) {
                        return callback(err);
                    }
                    address += packet.length;
                    offset += packet.length;
                    return callback();
                });
            },
            callback
        );
    }

    flash(address, data, callback) {
        this._runSystemMemoryFn((callback) => {
            async.series([
                this._cmdEraseAll.bind(this),
                this._writeAll.bind(this, address, data)
            ], callback);
        }, callback);
    }

    _withTimeoutAndData(begin, onData, timeoutMS, callback) {
        var callbackCalled = false;
        var done = (function _done(callback, err, arg) {
            clearTimeout(timeout);
            this._serialPort.removeAllListeners('data');
            if (!callbackCalled) {
                callbackCalled = true;
                return callback(err, arg);
            }
        }).bind(this, callback);

        var timeout = setTimeout(() => {
            this._serialPort.removeAllListeners('data');
            done(new Error('Timeout waiting for response'));
        }, timeoutMS);

        this._serialPort.on('data', (data) => {
            onData(data, done);
        });

        begin((err) => {
            if (err) {
                done(err);
            }
        });
    }

    static _sleep(ms, callback) {
        setTimeout(callback, ms);
    }

    _enterBootloader(callback) {
        this._withTimeoutAndData(
            (callback) => {
                this._serialPort.write(new Buffer([0x7f]), callback);
            },
            (data, callback) => {
                if (data.length != 1) {
                    return callback(new Error('Enter Bootloader: Expected length 1 found ' + data.length));
                }
                if (data[0] != 0x79) {
                    return callback(new Error('Enter Bootloader: Expected 0x79 found 0x' + data[0].toString(16)));
                }
                return callback();
            },
            1000,
            callback
        );
    }

    _cmdIsAvailable(cmd) {
        return this._availableCommands.indexOf(cmd) >= 0;
    }

    _getIdCmd(callback) {
        if (!this._cmdIsAvailable(CMD_ID)) {
            return callback(new Error('ID command not available'));
        }
        this._cmdWithAckBeginAndEnd(CMD_ID, (err, buffer) => {
            if (err) {
                return callback(err);
            }
            this._pid = (buffer[2] << 8) | buffer[3];
            return callback(null, this._pid);
        });
    }

    _getCmd(callback) {
        this._cmdWithAckBeginAndEnd(CMD_GET, (err, buffer) => {
            if (err) {
                return callback(err);
            }
            this._bootloaderVersion = buffer[2];
            this._availableCommands = [];
            for (var i = 3; i < buffer.length - 1; i++) {
                this._availableCommands.push(buffer[i]);
            }
            return callback();
        });
    }

    _cmdWithAckBeginAndEnd(cmd, callback) {
        var buffer = new BufferBuilder();
        var len = -1;
        this._withTimeoutAndData(
            (callback) => {
                this._serialPort.write(new Buffer([cmd, ~cmd]), callback);
            },
            (data, callback) => {
                if (buffer.length == 0 && data[0] != ACK) {
                    return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                }
                buffer.appendBuffer(data);
                if (buffer.length > 2 && len < 0) {
                    len = buffer.get()[1] + 4;
                }
                if (buffer.length == len) {
                    buffer = buffer.get();
                    if (buffer[buffer.length - 1] != ACK) {
                        return callback(new Error('Expected end ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                    }
                    return callback(null, buffer);
                }
            },
            1000,
            callback
        );
    }

    _cmdEraseAll(callback) {
        var len = 0;
        if (!this._cmdIsAvailable(CMD_ERASE)) {
            return callback(new Error('Erase command not available'));
        }
        this._withTimeoutAndData(
            (callback) => {
                this._serialPort.write(new Buffer([CMD_ERASE, ~CMD_ERASE]), callback);
            },
            (data, callback) => {
                if (data[0] != ACK) {
                    return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                }
                len += data.length;
                if (len == 2) {
                    return callback();
                }
                this._serialPort.write(new Buffer([0xff, 0x00]), (err) => {
                    if (err) {
                        return callback(err);
                    }
                });
            },
            30 * 1000,
            callback
        );
    }

    _runSystemMemoryFn(fn, callback) {
        async.series([
            this._openSerialPort.bind(this),
            this._assertReset.bind(this),
            this._setBoot0SystemMemory.bind(this),
            STM32USARTBootloader._sleep.bind(this, 10),
            this._deassertReset.bind(this),
            STM32USARTBootloader._sleep.bind(this, 500),
            this._enterBootloader.bind(this),
            this._getCmd.bind(this),
            this._getIdCmd.bind(this),
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
