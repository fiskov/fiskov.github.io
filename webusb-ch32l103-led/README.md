# 🔌 CH32L103 WebUSB LED & Button Demo

A focused WebUSB control page for the [CH32L103 WinUSB/WebUSB demo
firmware](https://github.com/fiskov/webUSB): drag a slider to set LED
brightness (PB8, TIM4_CH3 PWM) and watch button-press events (PA1,
debounced in firmware) show up live in the log — no drivers required on
any OS, thanks to the firmware's combined Microsoft OS 2.0 + WebUSB BOS
descriptors.

This page reuses the styling from the sibling [`../webusb`](../webusb)
WebUSB Explorer tool but is wired specifically to this device's protocol
(see below) rather than being a generic byte-level USB explorer.

## Firmware & protocol

Firmware source: https://github.com/fiskov/webUSB (`firmware/` +
`webusb-demo/`).

| Request / Event     | Direction              | Details                                            |
|----------------------|------------------------|-----------------------------------------------------|
| `SET_LED`            | Host→Device, Vendor    | `bRequest=0x02`, `wValue`=brightness 0..255         |
| `GET_LED`            | Device→Host, Vendor    | `bRequest=0x03`, returns 1 byte = brightness        |
| `GET_VERSION`        | Device→Host, Vendor    | `bRequest=0x05`, returns 3 bytes major/minor/patch  |
| `SET_DEBOUNCE_MS`    | Host→Device, Vendor    | `bRequest=0x06`, `wValue`=debounce interval (ms)    |
| Button-press event   | Device→Host, **EP1 IN interrupt** | 4 bytes little-endian `uint32` = ms since boot |

VID/PID: `0x1209` / `0x0001` (pid.codes test allocation).

## Requirements

Same as [`../webusb`](../webusb): Chrome/Edge desktop, served over HTTPS
or `localhost`.

## Troubleshooting

See [`../webusb/README.md`](../webusb/README.md) for the general
"Access denied" / udev-rule / Zadig guidance — it applies here too. This
page's **🐧 Copy udev Rule** button is pre-filled with this device's
VID/PID (`1209:0001`).
