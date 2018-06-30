const wpi = require('node-wiring-pi');
const STM32USARTBootloader = require('../');
const fs = require('fs');
const path = require('path');

async function flash() {
    wpi.wiringPiSetupPhys();

    const bootloader = new STM32USARTBootloader({
        resetPin: 11,
        boot0Pin: 13,
        serialPortPath: '/dev/serial0'
    });
    await bootloader.init();

    const data = fs.readFileSync(path.join(__dirname, 'blink.bin'));
    await bootloader.flash(0x08000000, data);
    console.log('done');
}

flash();
