// ===== Constants =====
const SLOT_COLORS_HEX = ['#4CAF50', '#2196F3', '#FF9800', '#E91E63'];
const SLOT_COLORS_RGB = [
    [76, 175, 80],
    [33, 150, 243],
    [255, 152, 0],
    [233, 30, 99]
];
const EMPTY_COLOR_RGB = [26, 26, 46];
const OVERLAP_COLOR_RGB = [255, 51, 51];
const NUM_SLOTS = 4;

// ===== State =====
/** @type {Array<{name:string, offset:number, size:number, data:Uint8Array, isBin:boolean}|null>} */
const slots = new Array(NUM_SLOTS).fill(null);
let totalSize = 512 * 1024; // default 512 KB

// ===== DOM References =====
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas.getContext('2d');
const minimapTooltip = document.getElementById('minimapTooltip');
const minimapHint = document.getElementById('minimapHint');
const addrStart = document.getElementById('addrStart');
const addrEnd = document.getElementById('addrEnd');
const downloadBinBtn = document.getElementById('downloadBin');
const downloadHexBtn = document.getElementById('downloadHex');
const actionInfo = document.getElementById('actionInfo');
const sizeInfo = document.getElementById('sizeInfo');

// ===== Utility =====

/**
 * Format a number as hex string with 0x prefix, padded to 8 digits.
 * @param {number} n
 * @returns {string}
 */
function toHex8(n) {
    return '0x' + n.toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Format size as "N bytes (0xHHHH)".
 * @param {number} n
 * @returns {string}
 */
function formatSize(n) {
    return `${n.toLocaleString()} bytes (${toHex8(n)})`;
}

/**
 * Parse a hex string (with or without 0x prefix) to integer.
 * Returns NaN on failure.
 * @param {string} s
 * @returns {number}
 */
function parseHexInput(s) {
    const trimmed = s.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) return NaN;
    return parseInt(trimmed, 16);
}

// ===== Intel HEX Parser =====

/**
 * Parse Intel HEX format from an ArrayBuffer.
 * Returns { offset: number, data: Uint8Array } or throws on error.
 * @param {ArrayBuffer} buffer
 * @returns {{ offset: number, data: Uint8Array }}
 */
function parseIntelHex(buffer) {
    const text = new TextDecoder('ascii').decode(buffer);
    const lines = text.split(/\r?\n/);

    let extendedAddress = 0; // for record type 02 (segment) and 04 (linear)
    let minAddr = Infinity;
    let maxAddr = -Infinity;

    // First pass: determine address range
    for (const line of lines) {
        if (!line.startsWith(':')) continue;
        const byteCount = parseInt(line.slice(1, 3), 16);
        const address   = parseInt(line.slice(3, 7), 16);
        const recType   = parseInt(line.slice(7, 9), 16);

        if (recType === 0x00) { // Data
            const absAddr = extendedAddress + address;
            if (absAddr < minAddr) minAddr = absAddr;
            if (absAddr + byteCount > maxAddr) maxAddr = absAddr + byteCount;
        } else if (recType === 0x02) { // Extended Segment Address
            const seg = parseInt(line.slice(9, 13), 16);
            extendedAddress = seg << 4;
        } else if (recType === 0x04) { // Extended Linear Address
            const upper = parseInt(line.slice(9, 13), 16);
            extendedAddress = upper << 16;
        } else if (recType === 0x01) { // EOF
            break;
        }
    }

    if (minAddr === Infinity) throw new Error('No data records found in HEX file');

    const dataSize = maxAddr - minAddr;
    const data = new Uint8Array(dataSize).fill(0xFF);

    // Second pass: fill data
    extendedAddress = 0;
    for (const line of lines) {
        if (!line.startsWith(':')) continue;
        const byteCount = parseInt(line.slice(1, 3), 16);
        const address   = parseInt(line.slice(3, 7), 16);
        const recType   = parseInt(line.slice(7, 9), 16);

        if (recType === 0x00) {
            const absAddr = extendedAddress + address;
            for (let i = 0; i < byteCount; i++) {
                const byte = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
                data[absAddr - minAddr + i] = byte;
            }
        } else if (recType === 0x02) {
            const seg = parseInt(line.slice(9, 13), 16);
            extendedAddress = seg << 4;
        } else if (recType === 0x04) {
            const upper = parseInt(line.slice(9, 13), 16);
            extendedAddress = upper << 16;
        } else if (recType === 0x01) {
            break;
        }
    }

    return { offset: minAddr, data };
}

// ===== BIN Parser =====

/**
 * Parse a raw binary file from an ArrayBuffer.
 * @param {ArrayBuffer} buffer
 * @param {number} offset
 * @returns {{ offset: number, data: Uint8Array }}
 */
function parseBin(buffer, offset) {
    return { offset, data: new Uint8Array(buffer) };
}

// ===== Merge =====

/**
 * Build a merged Uint8Array of totalSize bytes (filled with 0xFF).
 * Returns the merged buffer and an overlap map (array of booleans).
 * @returns {{ merged: Uint8Array, overlapMap: Uint8Array }}
 */
function buildMergedBuffer() {
    const merged = new Uint8Array(totalSize).fill(0xFF);
    // ownerMap[i] = slot index (0-3) that wrote byte i, or -1 if empty
    const ownerMap = new Int8Array(totalSize).fill(-1);
    const overlapMap = new Uint8Array(totalSize).fill(0);

    for (let s = 0; s < NUM_SLOTS; s++) {
        const slot = slots[s];
        if (!slot) continue;
        const { offset, data } = slot;
        for (let i = 0; i < data.length; i++) {
            const addr = offset + i;
            if (addr < 0 || addr >= totalSize) continue;
            if (ownerMap[addr] !== -1) {
                overlapMap[addr] = 1;
            }
            merged[addr] = data[i];
            ownerMap[addr] = s;
        }
    }

    return { merged, ownerMap, overlapMap };
}

// ===== Intel HEX Export =====

/**
 * Convert a Uint8Array to Intel HEX format string.
 * @param {Uint8Array} data
 * @returns {string}
 */
function toIntelHex(data) {
    const RECORD_SIZE = 16;
    let lines = [];
    let currentUpperAddr = -1;

    for (let addr = 0; addr < data.length; addr += RECORD_SIZE) {
        const upperAddr = (addr >> 16) & 0xFFFF;

        // Emit Extended Linear Address record if upper address changed
        if (upperAddr !== currentUpperAddr) {
            currentUpperAddr = upperAddr;
            const hi = (upperAddr >> 8) & 0xFF;
            const lo = upperAddr & 0xFF;
            const checksum = (0x100 - ((2 + 0 + 0 + 4 + hi + lo) & 0xFF)) & 0xFF;
            lines.push(`:02000004${hi.toString(16).padStart(2,'0').toUpperCase()}${lo.toString(16).padStart(2,'0').toUpperCase()}${checksum.toString(16).padStart(2,'0').toUpperCase()}`);
        }

        const count = Math.min(RECORD_SIZE, data.length - addr);
        const addrLo = addr & 0xFFFF;
        const addrHi8 = (addrLo >> 8) & 0xFF;
        const addrLo8 = addrLo & 0xFF;

        let sum = count + addrHi8 + addrLo8 + 0x00; // type 00
        let dataStr = '';
        for (let i = 0; i < count; i++) {
            const b = data[addr + i];
            sum += b;
            dataStr += b.toString(16).padStart(2, '0').toUpperCase();
        }
        const checksum = (0x100 - (sum & 0xFF)) & 0xFF;

        lines.push(`:${count.toString(16).padStart(2,'0').toUpperCase()}${addrHi8.toString(16).padStart(2,'0').toUpperCase()}${addrLo8.toString(16).padStart(2,'0').toUpperCase()}00${dataStr}${checksum.toString(16).padStart(2,'0').toUpperCase()}`);
    }

    lines.push(':00000001FF'); // EOF
    return lines.join('\r\n') + '\r\n';
}

// ===== Minimap =====

/**
 * Render the memory map minimap onto the canvas.
 */
function renderMinimap() {
    const W = minimapCanvas.width;
    const H = minimapCanvas.height;
    const imageData = minimapCtx.createImageData(W, H);
    const pixels = imageData.data;

    const { ownerMap, overlapMap } = buildMergedBuffer();
    const bytesPerPixel = totalSize / W;

    let hasAnyFile = slots.some(s => s !== null);
    let hasOverlap = false;

    for (let px = 0; px < W; px++) {
        const byteStart = Math.floor(px * bytesPerPixel);
        const byteEnd   = Math.floor((px + 1) * bytesPerPixel);

        // Determine dominant color for this pixel column
        // Priority: overlap > slot data > empty
        let r = EMPTY_COLOR_RGB[0];
        let g = EMPTY_COLOR_RGB[1];
        let b = EMPTY_COLOR_RGB[2];

        let slotCounts = [0, 0, 0, 0];
        let overlapCount = 0;
        let totalBytes = byteEnd - byteStart;

        for (let i = byteStart; i < byteEnd && i < totalSize; i++) {
            if (overlapMap[i]) {
                overlapCount++;
            } else if (ownerMap[i] >= 0) {
                slotCounts[ownerMap[i]]++;
            }
        }

        if (overlapCount > 0) {
            hasOverlap = true;
            r = OVERLAP_COLOR_RGB[0];
            g = OVERLAP_COLOR_RGB[1];
            b = OVERLAP_COLOR_RGB[2];
        } else {
            // Find dominant slot
            let maxCount = 0;
            let dominantSlot = -1;
            for (let s = 0; s < NUM_SLOTS; s++) {
                if (slotCounts[s] > maxCount) {
                    maxCount = slotCounts[s];
                    dominantSlot = s;
                }
            }
            if (dominantSlot >= 0) {
                r = SLOT_COLORS_RGB[dominantSlot][0];
                g = SLOT_COLORS_RGB[dominantSlot][1];
                b = SLOT_COLORS_RGB[dominantSlot][2];
            }
        }

        // Fill all rows for this pixel column
        for (let py = 0; py < H; py++) {
            const idx = (py * W + px) * 4;
            pixels[idx]     = r;
            pixels[idx + 1] = g;
            pixels[idx + 2] = b;
            pixels[idx + 3] = 255;
        }
    }

    minimapCtx.putImageData(imageData, 0, 0);

    // Update hint
    if (!hasAnyFile) {
        minimapHint.textContent = 'No files loaded';
    } else if (hasOverlap) {
        minimapHint.textContent = '⚠ Overlap detected!';
        minimapHint.style.color = '#ff3333';
    } else {
        const loadedCount = slots.filter(s => s !== null).length;
        minimapHint.textContent = `${loadedCount} file${loadedCount > 1 ? 's' : ''} loaded`;
        minimapHint.style.color = '';
    }

    // Update address labels
    addrStart.textContent = toHex8(0);
    addrEnd.textContent = toHex8(totalSize);
}

// ===== Minimap Tooltip =====

minimapCanvas.addEventListener('mousemove', (e) => {
    const rect = minimapCanvas.getBoundingClientRect();
    const scaleX = minimapCanvas.width / rect.width;
    const px = Math.floor((e.clientX - rect.left) * scaleX);
    const addr = Math.floor(px * (totalSize / minimapCanvas.width));

    if (addr < 0 || addr >= totalSize) {
        minimapTooltip.style.display = 'none';
        return;
    }

    // Find which slot owns this address
    let ownerName = 'Empty (0xFF)';
    let ownerColor = '#888';
    for (let s = 0; s < NUM_SLOTS; s++) {
        const slot = slots[s];
        if (!slot) continue;
        if (addr >= slot.offset && addr < slot.offset + slot.size) {
            ownerName = `Slot ${s + 1}: ${slot.name}`;
            ownerColor = SLOT_COLORS_HEX[s];
            break;
        }
    }

    minimapTooltip.innerHTML = `<span style="color:${ownerColor}">${ownerName}</span><br>${toHex8(addr)}`;
    minimapTooltip.style.display = 'block';
    minimapTooltip.style.left = (e.clientX + 14) + 'px';
    minimapTooltip.style.top  = (e.clientY - 10) + 'px';
});

minimapCanvas.addEventListener('mouseleave', () => {
    minimapTooltip.style.display = 'none';
});

// ===== Slot UI Update =====

/**
 * Update the UI for a given slot index.
 * @param {number} idx
 */
function updateSlotUI(idx) {
    const slot = slots[idx];
    const infoEl    = document.getElementById(`info-${idx}`);
    const nameEl    = document.getElementById(`name-${idx}`);
    const offsetDisp = document.getElementById(`offset-display-${idx}`);
    const offsetInput = document.getElementById(`offset-input-${idx}`);
    const sizeEl    = document.getElementById(`size-${idx}`);
    const clearBtn  = document.getElementById(`clear-${idx}`);
    const warningEl = document.getElementById(`warning-${idx}`);
    const warningText = document.getElementById(`warning-text-${idx}`);
    const dropZone  = document.getElementById(`drop-${idx}`);

    if (!slot) {
        infoEl.style.display = 'none';
        clearBtn.style.display = 'none';
        dropZone.style.display = 'flex';
        return;
    }

    infoEl.style.display = 'flex';
    clearBtn.style.display = 'flex';
    dropZone.style.display = 'none';

    nameEl.textContent = slot.name;
    sizeEl.textContent = formatSize(slot.size);

    if (slot.isBin) {
        // Editable offset for .bin files
        offsetDisp.style.display = 'none';
        offsetInput.style.display = 'inline-block';
        offsetInput.value = toHex8(slot.offset);
    } else {
        // Read-only offset for .hex files
        offsetDisp.style.display = 'inline';
        offsetInput.style.display = 'none';
        offsetDisp.textContent = toHex8(slot.offset);
    }

    // Validate: check bounds
    const warnings = [];
    if (slot.offset + slot.size > totalSize) {
        warnings.push(`⚠ Exceeds total size (${toHex8(totalSize)})`);
    }
    if (slot.offset < 0) {
        warnings.push('⚠ Negative offset');
    }

    if (warnings.length > 0) {
        warningEl.style.display = 'flex';
        warningText.textContent = warnings.join(' | ');
    } else {
        warningEl.style.display = 'none';
    }
}

/**
 * Update download button states.
 */
function updateDownloadButtons() {
    const hasAny = slots.some(s => s !== null);
    downloadBinBtn.disabled = !hasAny;
    downloadHexBtn.disabled = !hasAny;
    if (hasAny) {
        const count = slots.filter(s => s !== null).length;
        actionInfo.textContent = `${count} file${count > 1 ? 's' : ''} ready to export`;
    } else {
        actionInfo.textContent = 'Load at least one file to enable export';
    }
}

// ===== File Processing =====

/**
 * Process a dropped/selected file for a given slot.
 * @param {number} idx
 * @param {File} file
 */
async function processFile(idx, file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const isBin = ext === 'bin';
    const isHex = ext === 'hex';

    if (!isBin && !isHex) {
        showSlotError(idx, `Unsupported file type ".${ext}". Use .hex or .bin`);
        return;
    }

    try {
        const buffer = await file.arrayBuffer();
        let parsed;

        if (isHex) {
            parsed = parseIntelHex(buffer);
        } else {
            // .bin: default offset 0
            const existingOffset = slots[idx]?.isBin ? slots[idx].offset : 0;
            parsed = parseBin(buffer, existingOffset);
        }

        slots[idx] = {
            name: file.name,
            offset: parsed.offset,
            size: parsed.data.length,
            data: parsed.data,
            isBin
        };

        updateSlotUI(idx);
        renderMinimap();
        updateDownloadButtons();

    } catch (err) {
        showSlotError(idx, `Parse error: ${err.message}`);
    }
}

/**
 * Show an error message in a slot's warning area.
 * @param {number} idx
 * @param {string} msg
 */
function showSlotError(idx, msg) {
    const warningEl   = document.getElementById(`warning-${idx}`);
    const warningText = document.getElementById(`warning-text-${idx}`);
    const infoEl      = document.getElementById(`info-${idx}`);
    infoEl.style.display = 'flex';
    warningEl.style.display = 'flex';
    warningText.textContent = msg;
}

// ===== Drop Zone Setup =====

for (let i = 0; i < NUM_SLOTS; i++) {
    const dropZone = document.getElementById(`drop-${i}`);
    const slotIdx = i;

    // Drag over
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    // Drag leave
    dropZone.addEventListener('dragleave', (e) => {
        if (!dropZone.contains(e.relatedTarget)) {
            dropZone.classList.remove('drag-over');
        }
    });

    // Drop
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) processFile(slotIdx, file);
    });

    // Click to browse
    dropZone.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.hex,.bin';
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) processFile(slotIdx, file);
        });
        input.click();
    });

    // Clear button
    const clearBtn = document.getElementById(`clear-${i}`);
    clearBtn.addEventListener('click', () => {
        slots[slotIdx] = null;
        updateSlotUI(slotIdx);
        renderMinimap();
        updateDownloadButtons();
    });

    // Offset input change (for .bin files)
    const offsetInput = document.getElementById(`offset-input-${i}`);
    offsetInput.addEventListener('change', () => {
        const slot = slots[slotIdx];
        if (!slot || !slot.isBin) return;

        const val = parseHexInput(offsetInput.value);
        if (isNaN(val) || val < 0) {
            offsetInput.classList.add('invalid');
            return;
        }
        offsetInput.classList.remove('invalid');
        slot.offset = val;
        updateSlotUI(slotIdx);
        renderMinimap();
    });

    offsetInput.addEventListener('input', () => {
        const val = parseHexInput(offsetInput.value);
        if (isNaN(val) || val < 0) {
            offsetInput.classList.add('invalid');
        } else {
            offsetInput.classList.remove('invalid');
        }
    });
}

// ===== Total Size Selector =====

document.querySelectorAll('input[name="totalSize"]').forEach(radio => {
    radio.addEventListener('change', () => {
        totalSize = parseInt(radio.value);
        const kb = totalSize / 1024;
        sizeInfo.textContent = `${kb} KB = ${toHex8(totalSize)} bytes`;
        // Re-validate all slots
        for (let i = 0; i < NUM_SLOTS; i++) {
            updateSlotUI(i);
        }
        renderMinimap();
        updateDownloadButtons();
    });
});

// ===== Download =====

/**
 * Trigger a file download in the browser.
 * @param {Uint8Array|string} content
 * @param {string} filename
 * @param {string} mimeType
 */
function triggerDownload(content, filename, mimeType) {
    const blob = content instanceof Uint8Array
        ? new Blob([content], { type: mimeType })
        : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

downloadBinBtn.addEventListener('click', () => {
    const { merged } = buildMergedBuffer();
    triggerDownload(merged, 'merged.bin', 'application/octet-stream');
});

downloadHexBtn.addEventListener('click', () => {
    const { merged } = buildMergedBuffer();
    const hexStr = toIntelHex(merged);
    triggerDownload(new TextEncoder().encode(hexStr), 'merged.hex', 'text/plain');
});

// ===== Initial Render =====
renderMinimap();
updateDownloadButtons();

// Set initial size info label
(function () {
    const kb = totalSize / 1024;
    sizeInfo.textContent = `${kb} KB = ${toHex8(totalSize)} bytes`;
})();
