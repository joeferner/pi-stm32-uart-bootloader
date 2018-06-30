const wpi = require('node-wiring-pi');
const SerialPort = require("serialport");
const BufferBuilder = require('buffer-builder');
const NestedError = require('nested-error-stacks');

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
        this._serialPortBaudRate = options.serialPortBaudRate || 115200;
    }

    async init() {
        if (!this._initCalled) {
            try {
                wpi.pinMode(this._boot0Pin, wpi.OUTPUT);

                await this._setBoot0MainFlash();
                await this._deassertReset();
                this._initCalled = true;
            } catch (err) {
                throw new NestedError('could not initialize', err);
            }
        }
    }

    async _setBoot0MainFlash() {
        wpi.digitalWrite(this._boot0Pin, BOOT0_MAIN_FLASH);
    }

    async _setBoot0SystemMemory() {
        wpi.digitalWrite(this._boot0Pin, BOOT0_SYSTEM_MEMORY);
    }

    async _deassertReset() {
        wpi.digitalWrite(this._resetPin, 1);
        wpi.pinMode(this._resetPin, wpi.OUTPUT);
    }

    async _assertReset() {
        wpi.digitalWrite(this._resetPin, 0);
        wpi.pinMode(this._resetPin, wpi.INPUT);
    }

    async _openSerialPort() {
        this._serialPort = new SerialPort(this._serialPortPath, {
            baudRate: this._serialPortBaudRate,
            dataBits: 8,
            parity: 'even',
            stopBits: 1,
            autoOpen: false
        }, false);
        return new Promise((resolve, reject) => {
            this._serialPort.open((err) => {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }

    async _closeSerialPort() {
        return new Promise((resolve, reject) => {
            this._serialPort.removeAllListeners('data');
            this._serialPort.close((err) => {
                this._serialPort = null;
                if (err && err.message.indexOf('Port is not open') >= 0) {
                    err = null;
                }
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }

    static _calculateChecksumOfBuffer(buffer) {
        let checksum = 0x00;
        for (let i = 0; i < buffer.length; i++) {
            checksum = checksum ^ buffer[i];
        }
        return checksum;
    }

    async _cmdWrite(address, data) {
        console.log('write length: ' + data.length + ', address: 0x' + address.toString(16));
        const STATE = {
            SEND_ADDRESS: 0,
            SEND_DATA: 1,
            WAIT_FOR_DATA_ACK: 2,
            COMPLETE: 3,
            ERROR: 4
        };

        const addr0 = (address >> 24) & 0xff;
        const addr1 = (address >> 16) & 0xff;
        const addr2 = (address >> 8) & 0xff;
        const addr3 = (address >> 0) & 0xff;
        const addrChecksum = addr0 ^ addr1 ^ addr2 ^ addr3;
        let buffer;
        let state = STATE.SEND_ADDRESS;
        if (!this._cmdIsAvailable(CMD_WRITE_MEMORY)) {
            throw new Error('write memory command not available');
        }
        return this._withTimeoutAndData(
            (callback) => {
                this._serialPort.write(new Buffer([CMD_WRITE_MEMORY, ~CMD_WRITE_MEMORY]), callback);
            },
            (rx, callback) => {
                switch (state) {
                    case STATE.SEND_ADDRESS:
                        if (rx[0] !== ACK) {
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
                        if (rx[0] !== ACK) {
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
                        if (rx[0] !== ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected data ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.COMPLETE;
                        return callback();
                }
            },
            30 * 1000
        );
    }

    async _writeAll(startAddress, data) {
        console.log('write length: ' + data.length + ', startAddress: 0x' + startAddress.toString(16));
        let address = startAddress;
        let offset = 0;
        const length = data.length + (4 - (data.length % 4));
        while (offset < length) {
            const packet = Buffer.alloc(WRITE_PACKET_SIZE, 0xff);
            data.copy(packet, 0, offset);
            await this._cmdWrite(address, packet);
            address += packet.length;
            offset += packet.length;
        }
    }

    async flash(address, data) {
        return this._runSystemMemoryFn(async () => {
            await this._cmdEraseAll();
            await this._writeAll(address, data);
        });
    }

    async _withTimeoutAndData(begin, onData, timeoutMS) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._serialPort.removeAllListeners('data');
                done(timeoutError);
            }, timeoutMS);
            let callbackCalled = false;
            const done = (function _done(err, arg) {
                clearTimeout(timeout);
                this._serialPort.removeAllListeners('data');
                if (!callbackCalled) {
                    callbackCalled = true;
                    if (err) {
                        return reject(err);
                    }
                    return resolve(arg);
                }
            }).bind(this);

            const timeoutError = new Error('Timeout waiting for response');

            this._serialPort.on('data', (data) => {
                onData(data, done);
            });

            begin((err) => {
                if (err) {
                    done(err);
                }
            });
        });
    }

    static async _sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    async _enterBootloader() {
        return this._withTimeoutAndData(
            (callback) => {
                this._serialPort.write(new Buffer([0x7f]), callback);
            },
            (data, callback) => {
                if (data.length !== 1) {
                    return callback(new Error('Enter Bootloader: Expected length 1 found ' + data.length));
                }
                if (data[0] !== 0x79) {
                    return callback(new Error('Enter Bootloader: Expected 0x79 found 0x' + data[0].toString(16)));
                }
                return callback();
            },
            1000
        );
    }

    _cmdIsAvailable(cmd) {
        return this._availableCommands.indexOf(cmd) >= 0;
    }

    async _getIdCmd() {
        if (!this._cmdIsAvailable(CMD_ID)) {
            throw new Error('ID command not available');
        }
        const buffer = await this._cmdWithAckBeginAndEnd(CMD_ID);
        this._pid = (buffer[2] << 8) | buffer[3];
        return this._pid;
    }

    async _getCmd(callback) {
        const buffer = await this._cmdWithAckBeginAndEnd(CMD_GET);
        this._bootloaderVersion = buffer[2];
        this._availableCommands = [];
        for (let i = 3; i < buffer.length - 1; i++) {
            this._availableCommands.push(buffer[i]);
        }
    }

    async _cmdWithAckBeginAndEnd(cmd) {
        let buffer = new BufferBuilder();
        let len = -1;
        return this._withTimeoutAndData(
            (callback) => {
                this._serialPort.write(new Buffer([cmd, ~cmd]), callback);
            },
            (data, callback) => {
                if (buffer.length === 0 && data[0] !== ACK) {
                    return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                }
                buffer.appendBuffer(data);
                if (buffer.length > 2 && len < 0) {
                    len = buffer.get()[1] + 4;
                }
                if (buffer.length === len) {
                    buffer = buffer.get();
                    if (buffer[buffer.length - 1] !== ACK) {
                        return callback(new Error('Expected end ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                    }
                    return callback(null, buffer);
                }
            },
            1000
        );
    }

    async _cmdEraseAll() {
        let len = 0;
        if (!this._cmdIsAvailable(CMD_ERASE)) {
            throw new Error('Erase command not available');
        }
        return this._withTimeoutAndData(
            (callback) => {
                this._serialPort.write(new Buffer([CMD_ERASE, ~CMD_ERASE]), callback);
            },
            (data, callback) => {
                if (data[0] !== ACK) {
                    return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                }
                len += data.length;
                if (len === 2) {
                    return callback();
                }
                this._serialPort.write(new Buffer([0xff, 0x00]), (err) => {
                    if (err) {
                        return callback(err);
                    }
                });
            },
            30 * 1000
        );
    }

    async _runSystemMemoryFn(fn) {
        await this._openSerialPort();
        await this._assertReset();
        await this._setBoot0SystemMemory();
        await STM32USARTBootloader._sleep(10);
        await this._deassertReset();
        await STM32USARTBootloader._sleep(500);
        await this._enterBootloader();
        await this._getCmd();
        await this._getIdCmd();
        await fn();
        await this._assertReset();
        await this._setBoot0MainFlash();
        await this._closeSerialPort();
        await this._deassertReset();
    }
}

module.exports = STM32USARTBootloader;
