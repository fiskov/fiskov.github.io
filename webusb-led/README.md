# 🔌 WebUSB LED & Button Demo (CH32L103 / CH592F)

A focused WebUSB control page for the CH32L103 / CH592F WinUSB/WebUSB demo
firmware (https://github.com/fiskov/ch32l103_ch592f_web_usb): drag a
slider to set LED brightness and watch button-press events show up live in
the log — no drivers required on any OS, thanks to the firmware's combined
Microsoft OS 2.0 + WebUSB BOS descriptors.

Both boards speak the **identical protocol**, so this single page works
with either one:

| Board    | LED pin                          | Button pin              |
|----------|-----------------------------------|--------------------------|
| CH32L103 | PB8 (TIM4_CH3 hardware PWM)        | PA1                      |
| CH592F   | PA4 (TMR1 software PWM)            | PB22 (chip's BOOT pin)   |

## Firmware & protocol

Firmware source: https://github.com/fiskov/ch32l103_ch592f_web_usb
(`ch32l103/` and `ch592f/`).

| Request / Event     | Direction              | Details                                            |
|----------------------|------------------------|-----------------------------------------------------|
| `SET_LED`            | Host→Device, Vendor    | `bRequest=0x02`, `wValue`=brightness 0..255         |
| `GET_LED`            | Device→Host, Vendor    | `bRequest=0x03`, returns 1 byte = brightness        |
| `GET_VERSION`        | Device→Host, Vendor    | `bRequest=0x05`, returns 3 bytes major/minor/patch  |
| `SET_DEBOUNCE_MS`    | Host→Device, Vendor    | `bRequest=0x06`, `wValue`=debounce interval (ms)    |
| Button-press event   | Device→Host, **EP1 IN interrupt** | 4 bytes little-endian `uint32` = ms since boot |

VID/PID: `0x1209` / `0x0001` (pid.codes test allocation).

## Requirements

Chrome/Edge desktop, served over HTTPS or `localhost`.

## Troubleshooting

### "Access denied" on Connect

The OS kernel driver is claiming the device before the browser can.
On Linux, use the **🐧 Copy udev Rule** button (pre-filled with this
device's VID/PID, `1209:0001`), save the rule to `/etc/udev/rules.d/`,
then run:

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

On Windows, no driver installation should be needed at all — the
firmware's Microsoft OS 2.0 descriptors make Windows auto-bind
`winusb.sys`. If a stale driver is already bound, use
[Zadig](https://zadig.akeo.ie/) to switch it to WinUSB.

### Device not listed in picker

Make sure the device is physically connected, and on Linux, that the udev
rule is installed and the device has been replugged.
