var wpi = require('wiring-pi');
var STM32USARTBootloader = require('../');
var fs = require('fs');

wpi.wiringPiSetupPhys();

bootloader = new STM32USARTBootloader({
    _resetPin: 11,
    _boot0Pin: 13,
    _serialPortPath: '/dev/ttyAMA0'
});

var data = fs.readFileSync('blink.bin', {
    encoding: 'binary'
});
bootloader.flash(0x08000000, data, (err) => {
    if (err) {
        return console.error('could not flash image', err);
    }
    console.log('done');
});
