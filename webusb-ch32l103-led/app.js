/**
 * CH32L103 WebUSB LED & Button demo client.
 *
 * Talks to the firmware at:
 *   https://github.com/fiskov/webUSB (firmware/ + webusb-demo/)
 *
 * Protocol summary:
 *   - VID/PID: 0x1209 / 0x0001
 *   - Interface 0: vendor-specific (class 0xFF), with one interrupt IN
 *     endpoint (EP1) for button-press events; LED control goes over EP0
 *     control transfers.
 *   - SET_LED    : vendor request, bRequest=0x02, wValue=brightness(0..255)
 *   - GET_LED    : vendor request, bRequest=0x03, returns 1 byte brightness
 *   - GET_VERSION: vendor request, bRequest=0x05, returns 3 bytes major/minor/patch
 *   - SET_DEBOUNCE_MS: vendor request, bRequest=0x06, wValue=debounce ms
 *   - Button event: EP1 IN, 4 bytes little-endian uint32 = ms since boot
 *
 * The device advertises MS OS 2.0 (Windows WinUSB auto-bind) and WebUSB BOS
 * platform capabilities, so no driver installation is required on any OS.
 */

'use strict';

const USB_VENDOR_ID = 0x1209;
const USB_PRODUCT_ID = 0x0001;

const REQUEST_SET_LED = 0x02;
const REQUEST_GET_LED = 0x03;
const REQUEST_GET_VERSION = 0x05;
const REQUEST_SET_DEBOUNCE_MS = 0x06;

const BUTTON_ENDPOINT = 1; // EP1 IN, interrupt

const state = {
  /** @type {USBDevice|null} */
  device: null,
  connected: false,
  buttonPollActive: false,
};

const $ = (id) => document.getElementById(id);

const ui = {
  statusIndicator: $('status-indicator'),
  statusText:      $('status-text'),
  btnConnect:      $('btn-connect'),
  btnDisconnect:   $('btn-disconnect'),
  btnUdev:         $('btn-udev'),
  deviceInfo:      $('device-info'),
  brightness:      $('brightness'),
  brightnessValue: $('brightness-value'),
  btnLedOff:       $('btn-led-off'),
  btnLedFull:      $('btn-led-full'),
  debounceMs:      $('debounce-ms'),
  btnSetDebounce:  $('btn-set-debounce'),
  log:             $('log'),
  btnClearLog:     $('btn-clear-log'),
  unsupportedBanner: $('unsupported-banner'),
};

function log(message, level = 'info') {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML = `<span class="ts">[${ts}]</span><span class="msg">${escapeHtml(message)}</span>`;
  ui.log.appendChild(entry);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStatus(status, text) {
  ui.statusIndicator.className = 'status-indicator';
  const labels = {
    idle: 'No device connected',
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnected: 'Disconnected',
  };
  if (status === 'connected') ui.statusIndicator.classList.add('connected');
  if (status === 'connecting') ui.statusIndicator.classList.add('connecting');
  if (status === 'disconnected') ui.statusIndicator.classList.add('disconnected');
  ui.statusText.textContent = text ?? labels[status] ?? status;
}

function updateButtons() {
  const connected = state.connected;
  ui.btnConnect.disabled = connected;
  ui.btnDisconnect.disabled = !connected;
  ui.brightness.disabled = !connected;
  ui.btnLedOff.disabled = !connected;
  ui.btnLedFull.disabled = !connected;
  ui.debounceMs.disabled = !connected;
  ui.btnSetDebounce.disabled = !connected;
}

function renderDeviceInfo(device) {
  if (!device) {
    ui.deviceInfo.innerHTML = '<p class="placeholder">No device selected.</p>';
    return;
  }
  const hex = (n, pad = 4) => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(pad, '0');
  ui.deviceInfo.innerHTML = `
    <dl class="info-grid">
      <dt>Product</dt>      <dd>${escapeHtml(device.productName || '—')}</dd>
      <dt>Manufacturer</dt> <dd>${escapeHtml(device.manufacturerName || '—')}</dd>
      <dt>Serial</dt>       <dd>${escapeHtml(device.serialNumber || '—')}</dd>
      <dt>Vendor ID</dt>    <dd>${hex(device.vendorId)}</dd>
      <dt>Product ID</dt>   <dd>${hex(device.productId)}</dd>
      <dt>USB Version</dt>  <dd>${device.usbVersionMajor}.${device.usbVersionMinor}.${device.usbVersionSubminor}</dd>
    </dl>
  `;
}

async function connect() {
  if (!('usb' in navigator)) {
    log('WebUSB is not available in this browser.', 'error');
    return;
  }

  try {
    setStatus('connecting');
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID }]
    });
    state.device = device;
    renderDeviceInfo(device);

    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }
    await device.claimInterface(0);

    state.connected = true;
    log(`Connected to ${device.productName || 'CH32L103'}.`, 'ok');

    const version = await getFirmwareVersion();
    if (version) {
      log(`Firmware version: v${version.major}.${version.minor}.${version.patch}`, 'ok');
      setStatus('connected', `Connected — fw v${version.major}.${version.minor}.${version.patch}`);
    } else {
      setStatus('connected');
    }

    const current = await getLed();
    if (current !== null) {
      ui.brightness.value = current;
      ui.brightnessValue.textContent = current;
    }

    updateButtons();
    state.buttonPollActive = true;
    pollButtonEvents();
  } catch (err) {
    state.connected = false;
    setStatus('disconnected', 'Connection failed');
    if (err.name === 'NotFoundError') {
      log('No device selected (dialog cancelled).', 'warn');
    } else {
      log(`Connect error: ${err.message}`, 'error');
    }
    updateButtons();
  }
}

async function disconnect() {
  state.buttonPollActive = false;
  if (state.device) {
    try { await state.device.close(); } catch (_) {}
  }
  state.device = null;
  state.connected = false;
  setStatus('disconnected', 'Disconnected');
  renderDeviceInfo(null);
  log('Device disconnected.', 'warn');
  updateButtons();
}

/** Polls the EP1 interrupt IN endpoint for button-press events, resilient
 *  to transient transferIn() errors (retries after a short backoff). */
async function pollButtonEvents() {
  while (state.buttonPollActive && state.device) {
    try {
      const result = await state.device.transferIn(BUTTON_ENDPOINT, 8);
      if (!state.buttonPollActive) break;

      if (result.status === 'ok' && result.data && result.data.byteLength >= 4) {
        const ms = result.data.getUint32(0, true);
        log(`Button pressed: t=${ms} ms (${(ms / 1000).toFixed(1)} s since boot)`, 'data');
      } else if (result.status === 'stall') {
        try { await state.device.clearHalt('in', BUTTON_ENDPOINT); } catch (_) {}
      } else {
        log(`Button poll: unexpected status=${result.status}`, 'warn');
      }
    } catch (err) {
      if (!state.buttonPollActive) break;
      log(`Button poll error: ${err.message} (retrying)`, 'warn');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function setLed(brightness) {
  if (!state.device) return;
  try {
    const result = await state.device.controlTransferOut({
      requestType: 'vendor', recipient: 'device',
      request: REQUEST_SET_LED, value: brightness, index: 0
    });
    if (result.status !== 'ok') log(`SET_LED failed: status=${result.status}`, 'warn');
  } catch (err) {
    log(`SET_LED error: ${err.message}`, 'error');
  }
}

async function getLed() {
  if (!state.device) return null;
  try {
    const result = await state.device.controlTransferIn({
      requestType: 'vendor', recipient: 'device',
      request: REQUEST_GET_LED, value: 0, index: 0
    }, 1);
    if (result.status === 'ok' && result.data && result.data.byteLength >= 1) {
      return result.data.getUint8(0);
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function getFirmwareVersion() {
  if (!state.device) return null;
  try {
    const result = await state.device.controlTransferIn({
      requestType: 'vendor', recipient: 'device',
      request: REQUEST_GET_VERSION, value: 0, index: 0
    }, 3);
    if (result.status === 'ok' && result.data && result.data.byteLength >= 3) {
      return {
        major: result.data.getUint8(0),
        minor: result.data.getUint8(1),
        patch: result.data.getUint8(2),
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function setDebounceMs(ms) {
  if (!state.device) return;
  try {
    const result = await state.device.controlTransferOut({
      requestType: 'vendor', recipient: 'device',
      request: REQUEST_SET_DEBOUNCE_MS, value: Math.round(ms), index: 0
    });
    if (result.status === 'ok') {
      log(`Button debounce interval set to ${ms} ms`, 'ok');
    } else {
      log(`SET_DEBOUNCE_MS failed: status=${result.status}`, 'warn');
    }
  } catch (err) {
    log(`SET_DEBOUNCE_MS error: ${err.message}`, 'error');
  }
}

async function copyUdevRule() {
  const vid = USB_VENDOR_ID.toString(16).padStart(4, '0');
  const pid = USB_PRODUCT_ID.toString(16).padStart(4, '0');
  const rule = `SUBSYSTEM=="usb", ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}", MODE="0664", GROUP="plugdev"`;
  log(`udev rule for CH32L103 (${vid}:${pid}):`, 'info');
  log(`  ${rule}`, 'data');
  log(`Save to: /etc/udev/rules.d/99-webusb-${vid}${pid}.rules`, 'info');
  log('Then run: sudo udevadm control --reload-rules && sudo udevadm trigger', 'info');
  try {
    await navigator.clipboard.writeText(rule);
    log('Rule copied to clipboard!', 'ok');
  } catch (_) {
    log('Could not copy to clipboard — select the text above manually.', 'warn');
  }
}

let sliderDebounce = null;
function init() {
  if (!navigator.usb) {
    ui.unsupportedBanner.classList.remove('hidden');
    ui.btnConnect.disabled = true;
    log('WebUSB is not available in this browser.', 'error');
    return;
  }

  log('WebUSB is available. Click "Connect device" to begin.', 'ok');

  ui.btnConnect.addEventListener('click', connect);
  ui.btnDisconnect.addEventListener('click', disconnect);
  ui.btnUdev.addEventListener('click', copyUdevRule);
  ui.btnClearLog.addEventListener('click', () => { ui.log.innerHTML = ''; });

  ui.brightness.addEventListener('input', () => {
    const value = parseInt(ui.brightness.value, 10);
    ui.brightnessValue.textContent = value;
    clearTimeout(sliderDebounce);
    sliderDebounce = setTimeout(() => setLed(value), 15);
  });

  ui.btnLedOff.addEventListener('click', () => {
    ui.brightness.value = 0;
    ui.brightnessValue.textContent = 0;
    setLed(0);
  });

  ui.btnLedFull.addEventListener('click', () => {
    ui.brightness.value = 255;
    ui.brightnessValue.textContent = 255;
    setLed(255);
  });

  ui.btnSetDebounce.addEventListener('click', () => {
    const ms = parseFloat(ui.debounceMs.value);
    if (!isNaN(ms) && ms > 0) setDebounceMs(ms);
  });

  navigator.usb.addEventListener('disconnect', (event) => {
    if (state.device && event.device === state.device) {
      log('Device was physically disconnected.', 'warn');
      state.buttonPollActive = false;
      state.device = null;
      state.connected = false;
      setStatus('disconnected', 'Device was unplugged');
      renderDeviceInfo(null);
      updateButtons();
    }
  });

  updateButtons();
  setStatus('idle');
}

document.addEventListener('DOMContentLoaded', init);
