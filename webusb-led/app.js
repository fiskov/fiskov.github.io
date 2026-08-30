/**
 * CH32L103 / CH592F WebUSB LED & Button demo client.
 *
 * Talks to the firmware at:
 *   https://github.com/fiskov/ch32l103_ch592f_web_usb (ch32l103/ + ch592f/)
 *
 * Both boards expose the identical protocol below, so this single page
 * works with either one.
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
const REQUEST_GET_FILE_SIZE = 0x09;
const REQUEST_START_FILE_XFER = 0x0A;

const BUTTON_ENDPOINT = 1; // EP1 IN, interrupt
const FILE_ENDPOINT = 2;   // EP2 IN, bulk

// Synthetic BMP layout constants - must match firmware/User/filexfer.c exactly.
let IMG_WIDTH = 1024;
let IMG_HEIGHT = 2048;
const BMP_HEADER_LEN = 54;
const ROW_SIZE = IMG_WIDTH * 3;

/** Reproduces the firmware's deterministic byte pattern (filexfer.c) so
 *  every downloaded byte can be verified without a stored reference file. */
/* Two known image patterns, auto-detected from the first pixel:
 * - gradient (CH32L103 / CH592F firmware)
 * - 8x8 black/white checkerboard (CH585M benchmark firmware) */
function expectedGradientByte(offset) {
  if (offset < BMP_HEADER_LEN) return null;
  const pixelOffset = offset - BMP_HEADER_LEN;
  const rowFromBottom = Math.floor(pixelOffset / ROW_SIZE);
  const within = pixelOffset % ROW_SIZE;
  const col = Math.floor(within / 3);
  const channel = within % 3;
  const actualRow = (IMG_HEIGHT - 1) - rowFromBottom;
  if (channel === 0) return Math.floor((col * 255) / (IMG_WIDTH - 1));
  if (channel === 1) return Math.floor((actualRow * 255) / (IMG_HEIGHT - 1));
  return (col + actualRow) & 0xFF;
}

function expectedCheckerByte(offset) {
  if (offset < BMP_HEADER_LEN) return null;
  const pixelOffset = offset - BMP_HEADER_LEN;
  const rowFromBottom = Math.floor(pixelOffset / ROW_SIZE);
  const within = pixelOffset % ROW_SIZE;
  const col = Math.floor(within / 3);
  const actualRow = (IMG_HEIGHT - 1) - rowFromBottom;
  return ((Math.floor(actualRow / 8) + Math.floor(col / 8)) % 2) ? 0xFF : 0x00;
}

let expectedFileByte = expectedGradientByte;

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
  btnDownload:     $('btn-download'),
  downloadProgress: $('download-progress'),
  previewCanvas:   $('preview-canvas'),
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
  ui.btnDownload.disabled = !connected;
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
    log(`Connected to ${device.productName || 'device'}.`, 'ok');

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

/** Downloads the synthetic ~3MB BMP test file over EP2 bulk, verifying
 *  every pixel byte and rendering a scaled preview into the canvas. */
async function downloadAndVerifyFile() {
  if (!state.device) return;
  ui.btnDownload.disabled = true;
  ui.downloadProgress.textContent = 'Requesting file size...';

  try {
    const sizeResult = await state.device.controlTransferIn({
      requestType: 'vendor', recipient: 'device',
      request: REQUEST_GET_FILE_SIZE, value: 0, index: 0
    }, 4);
    if (sizeResult.status !== 'ok' || !sizeResult.data || sizeResult.data.byteLength < 4) {
      throw new Error(`GET_FILE_SIZE failed: status=${sizeResult.status}`);
    }
    const fileSize = sizeResult.data.getUint32(0, true);
    log(`File size: ${fileSize} bytes (${(fileSize / 1048576).toFixed(2)} MB)`, 'info');

    const startResult = await state.device.controlTransferOut({
      requestType: 'vendor', recipient: 'device',
      request: REQUEST_START_FILE_XFER, value: 0, index: 0
    });
    if (startResult.status !== 'ok') {
      throw new Error(`START_FILE_XFER failed: status=${startResult.status}`);
    }

    const fileBuf = new Uint8Array(fileSize);
    let received = 0;
    const t0 = performance.now();
    let lastUpdate = 0;
  
    // Request a large chunk per transferIn() (not one 64-byte USB packet
    // at a time): each JS-visible transferIn() call has async/IPC
    // overhead far larger than a single ~50us USB transaction, so
    // requesting 64 bytes at a time caps throughput at ~200 KB/s. A 16KB
    // chunk size lets the browser/OS aggregate many bulk transactions per
    // call and approach the device's real bulk-transfer speed.
    const CHUNK_SIZE = 16384;

    while (received < fileSize) {
      const result = await state.device.transferIn(FILE_ENDPOINT, CHUNK_SIZE);
      if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
        fileBuf.set(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength), received);
        received += result.data.byteLength;
        const now = performance.now();
        if (now - lastUpdate > 100) {
          lastUpdate = now;
          const pct = ((received / fileSize) * 100).toFixed(0);
          const kbps = (received / 1024) / ((now - t0) / 1000);
          ui.downloadProgress.textContent = `Downloading... ${pct}% (${kbps.toFixed(0)} KB/s)`;
        }
      } else if (result.status === 'stall') {
        try { await state.device.clearHalt('in', FILE_ENDPOINT); } catch (_) {}
      } else {
        throw new Error(`transferIn failed: status=${result.status}`);
      }
    }

    const elapsedSec = (performance.now() - t0) / 1000;
    const kbps = (fileSize / 1024) / elapsedSec;
    const mbitps = (kbps * 8) / 1024;
    log(`Downloaded ${fileSize} bytes in ${elapsedSec.toFixed(2)}s (${kbps.toFixed(1)} KB/s, ${mbitps.toFixed(2)} Mbit/s)`, 'ok');

    /* detect the image pattern from the first pixel (all channels equal
     * and 0x00/0xFF -> checkerboard, otherwise gradient) */
    const first = fileBuf[BMP_HEADER_LEN];
    const checker = first === fileBuf[BMP_HEADER_LEN + 1] &&
                    first === fileBuf[BMP_HEADER_LEN + 2] &&
                    (first === 0x00 || first === 0xFF);
    expectedFileByte = checker ? expectedCheckerByte : expectedGradientByte;
    log(checker ? 'Image pattern: 8x8 checkerboard.' : 'Image pattern: gradient.', 'info');

    /* Parse actual dimensions from the BMP header (self-describing) */
    const bmpWidth = fileBuf[18] | (fileBuf[19] << 8) | (fileBuf[20] << 16) | (fileBuf[21] << 24);
    const bmpHeight = fileBuf[22] | (fileBuf[23] << 8) | (fileBuf[24] << 16) | (fileBuf[25] << 24);
    IMG_WIDTH = bmpWidth;
    IMG_HEIGHT = bmpHeight;

    const magicOk = fileBuf[0] === 0x42 && fileBuf[1] === 0x4D;
    log(magicOk ? 'BMP header signature OK.' : 'BMP header signature MISMATCH!', magicOk ? 'ok' : 'error');

    let mismatches = 0;
    for (let i = BMP_HEADER_LEN; i < fileSize; i++) {
      const expected = expectedFileByte(i);
      if (fileBuf[i] !== expected) {
        mismatches++;
        if (mismatches <= 5) {
          log(`Byte mismatch at offset ${i}: got 0x${fileBuf[i].toString(16)}, expected 0x${expected.toString(16)}`, 'error');
        }
      }
    }

    if (mismatches === 0) {
      log(`VERIFICATION OK: all ${fileSize - BMP_HEADER_LEN} pixel bytes match the expected pattern.`, 'ok');
      ui.downloadProgress.textContent = `Done: ${(fileSize / 1048576).toFixed(2)} MB in ${elapsedSec.toFixed(2)}s (${kbps.toFixed(0)} KB/s) - verification OK`;
    } else {
      log(`VERIFICATION FAILED: ${mismatches} byte mismatches.`, 'error');
      ui.downloadProgress.textContent = `Done, but ${mismatches} byte mismatches found`;
    }

    renderPreview(fileBuf);
  } catch (err) {
    log(`Download error: ${err.message}`, 'error');
    ui.downloadProgress.textContent = `Error: ${err.message}`;
  } finally {
    ui.btnDownload.disabled = false;
  }
}

/** Renders the downloaded BMP (bottom-to-top rows, BGR pixels), downscaled
 *  to the canvas size, as a quick visual sanity check. */
function renderPreview(fileBuf) {
  const canvas = ui.previewCanvas;
  const ctx = canvas.getContext('2d');
  const scale = IMG_WIDTH / canvas.width;
  const imageData = ctx.createImageData(canvas.width, canvas.height);

  for (let y = 0; y < canvas.height; y++) {
    const srcRow = Math.floor(y * scale);
    const bmpRowFromBottom = (IMG_HEIGHT - 1) - srcRow;
    for (let x = 0; x < canvas.width; x++) {
      const srcCol = Math.floor(x * scale);
      const srcOffset = BMP_HEADER_LEN + bmpRowFromBottom * ROW_SIZE + srcCol * 3;
      const b = fileBuf[srcOffset];
      const g = fileBuf[srcOffset + 1];
      const r = fileBuf[srcOffset + 2];
      const dstIdx = (y * canvas.width + x) * 4;
      imageData.data[dstIdx] = r;
      imageData.data[dstIdx + 1] = g;
      imageData.data[dstIdx + 2] = b;
      imageData.data[dstIdx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  canvas.style.display = 'block';
}

async function copyUdevRule() {
  const vid = USB_VENDOR_ID.toString(16).padStart(4, '0');
  const pid = USB_PRODUCT_ID.toString(16).padStart(4, '0');
  const rule = `SUBSYSTEM=="usb", ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}", MODE="0664", GROUP="plugdev"`;
  log(`udev rule for this device (${vid}:${pid}):`, 'info');
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
  ui.btnDownload.addEventListener('click', downloadAndVerifyFile);

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
