# 🔌 WebUSB Explorer

A minimal, single-page browser tool for connecting to and communicating with USB devices via the [WebUSB API](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API).

## Features

- **Request** any USB device through the browser's native picker
- **Connect / Disconnect** — opens the device, selects configuration, claims all interfaces
- **Send data** — write raw hex bytes to any OUT endpoint
- **Receive data** — read raw bytes from any IN endpoint, displayed as hex + ASCII
- **udev rule helper** — generates and copies a ready-to-use Linux udev rule for the selected device
- Real-time **log** with timestamps and colour-coded severity levels

## Browser Support

| Browser | Supported |
|---------|-----------|
| Chrome / Chromium ≥ 61 | ✅ |
| Edge ≥ 79 | ✅ |
| Firefox | ❌ (WebUSB not implemented) |
| Safari | ❌ (WebUSB not implemented) |

## Quick Start

Open `index.html` directly in Chrome/Chromium, or serve the folder with any static HTTP server:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Linux Setup (udev rules)

On Linux, the kernel may block browser access to USB devices by default.  
Run the provided helper script once to install the udev rule for your device:

```bash
chmod +x setup-udev.sh
sudo ./setup-udev.sh
```

The script installs a rule for **VID `413d` / PID `2107`** (the default target device).  
After running it, replug the device and reload the page.

You can also generate a rule for any other device directly from the UI:
1. Click **🔍 Request Device** and select your device
2. Click **🐧 Copy udev Rule** — the rule is copied to the clipboard and printed in the log
3. Save it to `/etc/udev/rules.d/` and reload udev rules

## File Structure

```
webusb/
├── index.html       # Single-page application shell
├── style.css        # UI styles
├── webusb.js        # WebUSB logic & UI controller
├── setup-udev.sh    # Linux udev rule installer
└── README.md        # This file
```

## Troubleshooting

### "Access denied" on Connect

The OS kernel driver is claiming the device before the browser can.  
Follow the steps printed in the log, or run `setup-udev.sh` (Linux).

### Device not listed in picker

- Make sure the device is physically connected
- On Linux, ensure the udev rule is installed and the device has been replugged
- On Windows, install the WinUSB driver via [Zadig](https://zadig.akeo.ie/)

### Interface claim fails

Some devices expose interfaces that are already owned by a kernel driver (e.g. `usbhid`, `cdc_acm`).  
Detach the driver first:

```bash
sudo modprobe -r <driver_name>   # e.g. sudo modprobe -r cdc_acm
```

## License

MIT
