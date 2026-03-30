/**
 * WebUSB Explorer
 * Handles device request, connection, data transfer, and UI updates.
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  /** @type {USBDevice|null} */
  device: null,
  connected: false,
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const ui = {
  unsupportedBanner: $('unsupported-banner'),
  statusIndicator:   $('status-indicator'),
  statusText:        $('status-text'),
  btnRequest:        $('btn-request'),
  btnConnect:        $('btn-connect'),
  btnDisconnect:     $('btn-disconnect'),
  btnUdev:           $('btn-udev'),
  deviceInfo:        $('device-info'),
  btnSend:           $('btn-send'),
  btnReceive:        $('btn-receive'),
  endpointOut:       $('endpoint-out'),
  endpointIn:        $('endpoint-in'),
  sendData:          $('send-data'),
  recvLength:        $('recv-length'),
  log:               $('log'),
  btnClearLog:       $('btn-clear-log'),
};

// ── Logging ────────────────────────────────────────────────────────────────
/**
 * Append a timestamped entry to the on-screen log.
 * @param {string} message
 * @param {'info'|'ok'|'error'|'warn'|'data'} [level='info']
 */
function log(message, level = 'info') {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);

  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML =
    `<span class="ts">[${ts}]</span><span class="msg">${escapeHtml(message)}</span>`;

  ui.log.appendChild(entry);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Status helpers ─────────────────────────────────────────────────────────
/**
 * @param {'idle'|'connecting'|'connected'|'disconnected'} status
 * @param {string} [text]
 */
function setStatus(status, text) {
  const indicator = ui.statusIndicator;
  indicator.className = 'status-indicator';

  const labels = {
    idle:         'No device connected',
    connecting:   'Connecting…',
    connected:    'Connected',
    disconnected: 'Disconnected',
  };

  if (status === 'connected')    indicator.classList.add('connected');
  if (status === 'connecting')   indicator.classList.add('connecting');
  if (status === 'disconnected') indicator.classList.add('disconnected');

  ui.statusText.textContent = text ?? labels[status] ?? status;
}

// ── Button state ───────────────────────────────────────────────────────────
function updateButtons() {
  const hasDevice    = state.device !== null;
  const isConnected  = state.connected;

  ui.btnConnect.disabled    = !hasDevice || isConnected;
  ui.btnDisconnect.disabled = !isConnected;
  ui.btnSend.disabled       = !isConnected;
  ui.btnReceive.disabled    = !isConnected;
  ui.btnUdev.disabled       = !hasDevice;
}

// ── Device info rendering ──────────────────────────────────────────────────
function renderDeviceInfo(device) {
  if (!device) {
    ui.deviceInfo.innerHTML = '<p class="placeholder">No device selected.</p>';
    return;
  }

  const hex = (n, pad = 4) => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(pad, '0');

  // Build interface/endpoint table
  let ifaceRows = '';
  for (const cfg of device.configurations ?? []) {
    for (const iface of cfg.interfaces ?? []) {
      for (const alt of iface.alternates ?? []) {
        for (const ep of alt.endpoints ?? []) {
          ifaceRows += `
            <tr>
              <td>${cfg.configurationValue}</td>
              <td>${iface.interfaceNumber}</td>
              <td>${alt.alternateSetting}</td>
              <td>${ep.endpointNumber}</td>
              <td>${ep.direction}</td>
              <td>${ep.type}</td>
              <td>${ep.packetSize}</td>
            </tr>`;
        }
      }
    }
  }

  ui.deviceInfo.innerHTML = `
    <dl class="info-grid">
      <dt>Product</dt>       <dd>${escapeHtml(device.productName  || '—')}</dd>
      <dt>Manufacturer</dt>  <dd>${escapeHtml(device.manufacturerName || '—')}</dd>
      <dt>Serial</dt>        <dd>${escapeHtml(device.serialNumber || '—')}</dd>
      <dt>Vendor ID</dt>     <dd>${hex(device.vendorId)}</dd>
      <dt>Product ID</dt>    <dd>${hex(device.productId)}</dd>
      <dt>USB Version</dt>   <dd>${device.usbVersionMajor}.${device.usbVersionMinor}.${device.usbVersionSubminor}</dd>
      <dt>Device Class</dt>  <dd>${hex(device.deviceClass, 2)}</dd>
    </dl>
    ${ifaceRows ? `
    <details class="iface-list">
      <summary>Endpoints (${ifaceRows.split('<tr>').length - 1})</summary>
      <table class="iface-table">
        <thead>
          <tr>
            <th>Cfg</th><th>Iface</th><th>Alt</th>
            <th>EP#</th><th>Dir</th><th>Type</th><th>Pkt</th>
          </tr>
        </thead>
        <tbody>${ifaceRows}</tbody>
      </table>
    </details>` : ''}
  `;
}

// ── WebUSB: Request device ─────────────────────────────────────────────────
async function requestDevice() {
  try {
    log('Requesting USB device access…');
    // Empty filters = show all USB devices
    const device = await navigator.usb.requestDevice({ filters: [] });
    state.device = device;
    log(`Device selected: ${device.productName || 'Unknown'} (${device.manufacturerName || 'Unknown manufacturer'})`, 'ok');
    renderDeviceInfo(device);
    setStatus('idle', `Device selected — ${device.productName || 'Unknown'}`);
    updateButtons();
  } catch (err) {
    if (err.name === 'NotFoundError') {
      log('No device selected (dialog cancelled).', 'warn');
    } else {
      log(`Request failed: ${err.message}`, 'error');
    }
  }
}

// ── WebUSB: Connect ────────────────────────────────────────────────────────
async function connectDevice() {
  if (!state.device) return;
  try {
    setStatus('connecting');
    log('Opening device…');
    await state.device.open();

    // Select configuration #1 if not already configured
    if (state.device.configuration === null) {
      log('Selecting configuration 1…');
      await state.device.selectConfiguration(1);
    }

    // Claim all interfaces
    const ifaces = state.device.configuration?.interfaces ?? [];
    let anyClaimed = false;
    let anyProtected = false;
    for (const iface of ifaces) {
      try {
        await state.device.claimInterface(iface.interfaceNumber);
        log(`Claimed interface ${iface.interfaceNumber}`, 'ok');
        anyClaimed = true;
      } catch (e) {
        if (e.message && e.message.toLowerCase().includes('protected class')) {
          anyProtected = true;
          log(`Could not claim interface ${iface.interfaceNumber}: protected by kernel driver`, 'warn');
        } else {
          log(`Could not claim interface ${iface.interfaceNumber}: ${e.message}`, 'warn');
        }
      }
    }

    if (anyProtected && !anyClaimed) {
      // All interfaces are kernel-owned — treat as a hard failure
      logProtectedClassHelp();
      state.connected = false;
      setStatus('disconnected', 'Connection failed — protected device');
      try { await state.device.close(); } catch (_) {}
      updateButtons();
      return;
    }

    if (anyProtected) {
      logProtectedClassHelp();
    }

    state.connected = true;
    setStatus('connected', `Connected — ${state.device.productName || 'USB Device'}`);
    log('Device connected successfully.', 'ok');
    updateButtons();
  } catch (err) {
    state.connected = false;
    setStatus('disconnected', 'Connection failed');

    if (err.message && err.message.toLowerCase().includes('access denied')) {
      logAccessDeniedHelp();
    } else {
      log(`Connect error: ${err.message}`, 'error');
    }
    updateButtons();
  }
}

// ── udev rule helper ───────────────────────────────────────────────────────
/**
 * Copy a ready-to-use udev rule for the selected device to the clipboard
 * and print it to the log.
 */
async function copyUdevRule() {
  if (!state.device) return;
  const vid = state.device.vendorId.toString(16).toLowerCase().padStart(4, '0');
  const pid = state.device.productId.toString(16).toLowerCase().padStart(4, '0');
  const rule =
    `SUBSYSTEM=="usb", ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}", MODE="0664", GROUP="plugdev"`;
  const filename = `99-webusb-${vid}${pid}.rules`;

  log(`udev rule for ${state.device.productName || 'device'} (${vid}:${pid}):`, 'info');
  log(`  ${rule}`, 'data');
  log(`Save to: /etc/udev/rules.d/${filename}`, 'info');
  log('Then run: sudo udevadm control --reload-rules && sudo udevadm trigger', 'info');
  log('And add yourself to plugdev: sudo usermod -aG plugdev $USER', 'info');

  try {
    await navigator.clipboard.writeText(rule);
    log('Rule copied to clipboard!', 'ok');
  } catch (_) {
    log('Could not copy to clipboard — select the text above manually.', 'warn');
  }
}

/**
 * Print a detailed, actionable explanation when the OS blocks device access.
 * Common on Linux when a kernel driver (usbhid, cdc_acm, etc.) owns the device.
 */
function logAccessDeniedHelp() {
  const d = state.device;
  const vid = d ? d.vendorId.toString(16).toUpperCase().padStart(4, '0') : 'XXXX';
  const pid = d ? d.productId.toString(16).toUpperCase().padStart(4, '0') : 'XXXX';

  log('Connect error: Access denied — the OS is blocking browser access to this device.', 'error');
  log('━━━ How to fix on Linux ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'warn');
  log('Step 1 — Create a udev rule to grant browser access:', 'warn');
  log(`  sudo tee /etc/udev/rules.d/99-webusb.rules <<'EOF'`, 'warn');
  log(`  SUBSYSTEM=="usb", ATTRS{idVendor}=="${vid.toLowerCase()}", ATTRS{idProduct}=="${pid.toLowerCase()}", MODE="0664", GROUP="plugdev"`, 'warn');
  log('  EOF', 'warn');
  log('  sudo udevadm control --reload-rules && sudo udevadm trigger', 'warn');
  log('Step 2 — Add your user to the plugdev group (if not already):', 'warn');
  log('  sudo usermod -aG plugdev $USER   ← then log out and back in', 'warn');
  log('Step 3 — If a kernel driver owns the device (e.g. usbhid, cdc_acm),', 'warn');
  log('  detach it:  sudo modprobe -r <driver_name>', 'warn');
  log('Step 4 — Replug the device, then try Connect again.', 'warn');
  log('━━━ macOS / Windows ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'warn');
  log('  macOS: no extra steps needed for most devices.', 'warn');
  log('  Windows: install WinUSB driver via Zadig (https://zadig.akeo.ie/).', 'warn');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'warn');
}

/**
 * Print actionable help when one or more interfaces are owned by a kernel
 * driver and the browser cannot claim them ("protected class" error).
 * Common culprits: usbhid (HID devices), cdc_acm (serial/modem), cdc_ether…
 */
function logProtectedClassHelp() {
  const d = state.device;
  const vid = d ? d.vendorId.toString(16).toLowerCase().padStart(4, '0') : 'xxxx';
  const pid = d ? d.productId.toString(16).toLowerCase().padStart(4, '0') : 'xxxx';

  log('━━━ Interface protected by kernel driver ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'warn');
  log('The OS kernel has claimed this interface (e.g. usbhid, cdc_acm, cdc_ether).', 'warn');
  log('The browser cannot access it until the kernel driver is detached.', 'warn');
  log('', 'warn');
  log('── Option A: detach the kernel driver temporarily ──────────────────────────', 'warn');
  log('  Find the driver name:', 'warn');
  log(`    lsusb -d ${vid}:${pid} -v | grep -i driver`, 'warn');
  log('  Then detach it (replace <driver> with the actual name, e.g. usbhid):', 'warn');
  log('    sudo modprobe -r <driver>', 'warn');
  log('  Replug the device, then click Connect again.', 'warn');
  log('  To restore: sudo modprobe <driver>', 'warn');
  log('', 'warn');
  log('── Option B: udev rule + plugdev group (Linux) ──────────────────────────────', 'warn');
  log('  Some devices also need a udev rule so the browser can open them:', 'warn');
  log(`  SUBSYSTEM=="usb", ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}", MODE="0664", GROUP="plugdev"`, 'warn');
  log(`  Save to /etc/udev/rules.d/99-webusb-${vid}${pid}.rules`, 'warn');
  log('  sudo udevadm control --reload-rules && sudo udevadm trigger', 'warn');
  log('  sudo usermod -aG plugdev $USER   ← log out and back in', 'warn');
  log('', 'warn');
  log('── Windows ──────────────────────────────────────────────────────────────────', 'warn');
  log('  Replace the driver with WinUSB using Zadig: https://zadig.akeo.ie/', 'warn');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'warn');
}

// ── WebUSB: Disconnect ─────────────────────────────────────────────────────
async function disconnectDevice() {
  if (!state.device) return;
  try {
    // Release all claimed interfaces
    const ifaces = state.device.configuration?.interfaces ?? [];
    for (const iface of ifaces) {
      try { await state.device.releaseInterface(iface.interfaceNumber); } catch (_) {}
    }
    await state.device.close();
    state.connected = false;
    setStatus('disconnected', 'Disconnected');
    log('Device disconnected.', 'warn');
    updateButtons();
  } catch (err) {
    log(`Disconnect error: ${err.message}`, 'error');
  }
}

// ── WebUSB: Send data ──────────────────────────────────────────────────────
async function sendData() {
  if (!state.connected) return;

  const epNum   = parseInt(ui.endpointOut.value, 10);
  const hexStr  = ui.sendData.value.trim();

  if (!hexStr) {
    log('No data to send. Enter hex bytes in the Send field.', 'warn');
    return;
  }

  let bytes;
  try {
    bytes = parseHex(hexStr);
  } catch (e) {
    log(`Invalid hex input: ${e.message}`, 'error');
    return;
  }

  try {
    log(`Sending ${bytes.length} byte(s) to endpoint ${epNum}: ${formatHex(bytes)}`);
    const result = await state.device.transferOut(epNum, bytes);
    if (result.status === 'ok') {
      log(`Sent ${result.bytesWritten} byte(s) successfully.`, 'ok');
    } else {
      log(`Transfer status: ${result.status}`, 'warn');
    }
  } catch (err) {
    log(`Send error: ${err.message}`, 'error');
  }
}

// ── WebUSB: Receive data ───────────────────────────────────────────────────
async function receiveData() {
  if (!state.connected) return;

  const epNum  = parseInt(ui.endpointIn.value, 10);
  const length = parseInt(ui.recvLength.value, 10);

  if (isNaN(length) || length < 1) {
    log('Invalid receive length.', 'warn');
    return;
  }

  try {
    log(`Reading up to ${length} byte(s) from endpoint ${epNum}…`);
    const result = await state.device.transferIn(epNum, length);

    if (result.status === 'ok') {
      const data = new Uint8Array(result.data.buffer);
      log(`Received ${data.length} byte(s): ${formatHex(data)}`, 'data');
      // Also show as ASCII where printable
      const ascii = Array.from(data)
        .map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.')
        .join('');
      log(`ASCII: ${ascii}`, 'data');
    } else {
      log(`Transfer status: ${result.status}`, 'warn');
    }
  } catch (err) {
    log(`Receive error: ${err.message}`, 'error');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
/**
 * Parse a space/comma-separated hex string into a Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 */
function parseHex(str) {
  const tokens = str.split(/[\s,]+/).filter(Boolean);
  const bytes = tokens.map(t => {
    const n = parseInt(t, 16);
    if (isNaN(n) || n < 0 || n > 255) throw new Error(`"${t}" is not a valid byte`);
    return n;
  });
  return new Uint8Array(bytes);
}

/**
 * Format a Uint8Array as uppercase hex pairs.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function formatHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

// ── USB disconnect event ───────────────────────────────────────────────────
navigator.usb.addEventListener('disconnect', (event) => {
  if (state.device && event.device === state.device) {
    state.connected = false;
    state.device    = null;
    setStatus('disconnected', 'Device was unplugged');
    renderDeviceInfo(null);
    log('Device was physically disconnected.', 'warn');
    updateButtons();
  }
});

// ── USB connect event (auto-select if no device held) ─────────────────────
navigator.usb.addEventListener('connect', (event) => {
  log(`USB device attached: ${event.device.productName || 'Unknown device'}`, 'info');
});

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  // Check WebUSB support
  if (!navigator.usb) {
    ui.unsupportedBanner.classList.remove('hidden');
    ui.btnRequest.disabled  = true;
    ui.btnConnect.disabled  = true;
    log('WebUSB is not available in this browser.', 'error');
    return;
  }

  log('WebUSB is available. Click "Request Device" to begin.', 'ok');

  // Wire up buttons
  ui.btnRequest.addEventListener('click', requestDevice);
  ui.btnConnect.addEventListener('click', connectDevice);
  ui.btnDisconnect.addEventListener('click', disconnectDevice);
  ui.btnUdev.addEventListener('click', copyUdevRule);
  ui.btnSend.addEventListener('click', sendData);
  ui.btnReceive.addEventListener('click', receiveData);
  ui.btnClearLog.addEventListener('click', () => { ui.log.innerHTML = ''; });

  // Allow Enter key in send field
  ui.sendData.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendData();
  });

  updateButtons();
  setStatus('idle');
}

document.addEventListener('DOMContentLoaded', init);
