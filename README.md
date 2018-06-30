
**Raspberry PI STM32 USART Bootloader**

This node module facilitates flashing an STM32 over the built in USART bootloader.

The STM32 has a built in bootloader which can be accessed by setting the following
BOOT1 and BOOT0 pins. "Main Flash Memory" is where your program typically resides.
"System Memory" is where STM32's built in bootloaders reside.

| BOOT1 | BOOT0 | Boot Mode         |
|:-----:|:-----:|-------------------|
|   x   |   0   | Main Flash Memory |
|   0   |   1   | System Memory     |
|   1   |   1   | Embedded SRAM     |

This module will toggle these pins (BOOT0 and BOOT1) along with the reset pin and USART
to flash the STM32.

### Raspberry Pi 3

On the Raspberry Pi 3 yo get better baud rate results you will probably want to remap the
physical USART away from the bluetooth and back to the USART pins. To do this add the following
line to your `/boot/config.txt` file.

```
dtoverlay=pi3-miniuart-bt
```

### Usage

The following example has been tested to flash the STM32F103RBT6 on the STM32F103 Nucleo board.
You'll need to make the following connections.

|  Pi  | STM32            |
|-----:|------------------|
|  8   | USART RX PA10    |
|  10  | USART TX PA9     |
|  11  | RESET            |
|  13  | BOOT0            |
|      | BOOT1/PB2 -> GND |

You will also need to disable the built in Nucleo reset by removing the jumper on `SB12` or
replacing it with a weak pull up resistor (10K should work).

```javascript
var wpi = require('wiring-pi');
var STM32USARTBootloader = require('pi-stm32-usart-bootloader');
var fs = require('fs');
var path = require('path');

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
```
