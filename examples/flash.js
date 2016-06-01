var wpi = require('wiring-pi');
var STM32USARTBootloader = require('../');
var fs = require('fs');
var path = require('path');

wpi.wiringPiSetupPhys();

bootloader = new STM32USARTBootloader({
    resetPin: 11,
    boot0Pin: 13,
    serialPortPath: '/dev/ttyAMA0'
});

var data = fs.readFileSync(path.join(__dirname, 'blink.bin'));
bootloader.flash(0x08000000, data, (err) => {
    if (err) {
        return console.error('could not flash image', err);
    }
    console.log('done');
});
