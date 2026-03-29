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
let renderedSlotCount = 0;  // how many slot cards exist in the DOM

// ===== Constants =====
const HEX_ADDR_MASK  = 0xFFFFF;   // 1 MB mask — strip upper base (e.g. 0x08000000)
const STM32_BASE     = 0x08000000; // STM32 flash base address

// ===== DOM References =====
const slotsGrid      = document.getElementById('slots-grid');
const minimapCanvas  = document.getElementById('minimap');
const minimapCtx     = minimapCanvas.getContext('2d');
const minimapTooltip = document.getElementById('minimapTooltip');
const minimapHint    = document.getElementById('minimapHint');
const addrStart      = document.getElementById('addrStart');
const addrEnd        = document.getElementById('addrEnd');
const downloadBinBtn = document.getElementById('downloadBin');
const downloadHexBtn = document.getElementById('downloadHex');
const actionInfo     = document.getElementById('actionInfo');
const sizeInfo       = document.getElementById('sizeInfo');

// ===== Utility =====

function toHex8(n) {
    return '0x' + n.toString(16).toUpperCase().padStart(8, '0');
}

function formatSize(n) {
    return `${n.toLocaleString()} bytes (${toHex8(n)})`;
}

function parseHexInput(s) {
    const trimmed = s.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) return NaN;
    return parseInt(trimmed, 16);
}

// ===== Slot Card DOM Builder =====

/**
 * Create and append a slot card for index `idx` to the grid.
 * @param {number} idx
 */
function createSlotCard(idx) {
    const card = document.createElement('div');
    card.className = 'slot-card';
    card.id = `slot-${idx}`;
    card.dataset.slot = idx;

    card.innerHTML = `
        <div class="slot-header slot-color-${idx}">
            <span class="slot-label">Slot ${idx + 1}</span>
            <button class="slot-clear-btn" id="clear-${idx}" title="Clear slot" style="display:none">✕</button>
        </div>
        <div class="drop-zone" id="drop-${idx}">
            <div class="drop-zone-content">
                <svg class="drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <p class="drop-text">Drop .hex or .bin file</p>
                <p class="drop-hint">or click to browse</p>
            </div>
        </div>
        <div class="file-info" id="info-${idx}" style="display:none">
            <div class="info-row">
                <span class="info-label">📄 Name</span>
                <span class="info-value" id="name-${idx}">—</span>
            </div>
            <div class="info-row">
                <span class="info-label">📍 Offset</span>
                <span class="info-value" id="offset-display-${idx}">—</span>
                <input class="offset-input" id="offset-input-${idx}" type="text" placeholder="0x00000000" style="display:none" data-slot="${idx}">
            </div>
            <div class="info-row">
                <span class="info-label">📦 Size</span>
                <span class="info-value" id="size-${idx}">—</span>
            </div>
            <div class="info-row warning-row" id="warning-${idx}" style="display:none">
                <span class="warning-text" id="warning-text-${idx}"></span>
            </div>
        </div>
    `;

    slotsGrid.appendChild(card);
    bindSlotEvents(idx);
    renderedSlotCount++;
}

/**
 * Bind drag/drop, click, clear, and offset-input events for slot `idx`.
 * @param {number} idx
 */
function bindSlotEvents(idx) {
    const dropZone    = document.getElementById(`drop-${idx}`);
    const clearBtn    = document.getElementById(`clear-${idx}`);
    const offsetInput = document.getElementById(`offset-input-${idx}`);

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

    // Drop — support multiple files
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) processFileList(idx, files);
    });

    // Click to browse — support multiple files
    dropZone.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.hex,.bin';
        input.multiple = true;
        input.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) processFileList(idx, files);
        });
        input.click();
    });

    // Clear button — remove this slot and shift remaining slots up
    clearBtn.addEventListener('click', () => {
        removeSlot(idx);
    });

    // Offset input (for .bin files)
    offsetInput.addEventListener('change', () => {
        const slot = slots[idx];
        if (!slot || !slot.isBin) return;
        const val = parseHexInput(offsetInput.value);
        if (isNaN(val) || val < 0) {
            offsetInput.classList.add('invalid');
            return;
        }
        offsetInput.classList.remove('invalid');
        slot.offset = val;
        updateSlotUI(idx);
        renderMinimap();
    });

    offsetInput.addEventListener('input', () => {
        const val = parseHexInput(offsetInput.value);
        offsetInput.classList.toggle('invalid', isNaN(val) || val < 0);
    });
}

// ===== Slot Management =====

/**
 * Remove slot at `idx`, shift all subsequent slots left, then rebuild DOM.
 * @param {number} idx
 */
function removeSlot(idx) {
    // Shift slots array: remove element at idx, push null at end
    slots.splice(idx, 1);
    slots.push(null);
    rebuildAllSlots();
    renderMinimap();
    updateDownloadButtons();
}

/**
 * Rebuild all slot cards from scratch based on current slots[] state.
 * Keeps filled slots + exactly one trailing empty slot (up to NUM_SLOTS).
 */
function rebuildAllSlots() {
    // Remove all existing cards
    slotsGrid.innerHTML = '';
    renderedSlotCount = 0;

    // Determine how many cards to show: filled slots + 1 empty (capped at NUM_SLOTS)
    const filledCount = slots.filter(s => s !== null).length;
    const cardCount = Math.min(filledCount + 1, NUM_SLOTS);

    for (let i = 0; i < cardCount; i++) {
        createSlotCard(i);
        if (slots[i]) updateSlotUI(i);
    }
}

/**
 * Ensure there is exactly one trailing empty slot (if total < NUM_SLOTS).
 * Called after a file is successfully loaded.
 */
function ensureTrailingEmptySlot() {
    const filledCount = slots.filter(s => s !== null).length;
    const desired = Math.min(filledCount + 1, NUM_SLOTS);
    while (renderedSlotCount < desired) {
        createSlotCard(renderedSlotCount);
    }
}

// ===== Intel HEX Parser =====

function parseIntelHex(buffer) {
    const text = new TextDecoder('ascii').decode(buffer);
    const lines = text.split(/\r?\n/);

    let extendedAddress = 0;
    let minAddr = Infinity;
    let maxAddr = -Infinity;

    for (const line of lines) {
        if (!line.startsWith(':')) continue;
        const byteCount = parseInt(line.slice(1, 3), 16);
        const address   = parseInt(line.slice(3, 7), 16);
        const recType   = parseInt(line.slice(7, 9), 16);

        if (recType === 0x00) {
            // Apply 1M mask to strip upper base address (e.g. 0x08000000)
            const absAddr = (extendedAddress + address) & HEX_ADDR_MASK;
            if (absAddr < minAddr) minAddr = absAddr;
            if (absAddr + byteCount > maxAddr) maxAddr = absAddr + byteCount;
        } else if (recType === 0x02) {
            extendedAddress = parseInt(line.slice(9, 13), 16) << 4;
        } else if (recType === 0x04) {
            extendedAddress = parseInt(line.slice(9, 13), 16) << 16;
        } else if (recType === 0x01) {
            break;
        }
    }

    if (minAddr === Infinity) throw new Error('No data records found in HEX file');

    const data = new Uint8Array(maxAddr - minAddr).fill(0xFF);

    extendedAddress = 0;
    for (const line of lines) {
        if (!line.startsWith(':')) continue;
        const byteCount = parseInt(line.slice(1, 3), 16);
        const address   = parseInt(line.slice(3, 7), 16);
        const recType   = parseInt(line.slice(7, 9), 16);

        if (recType === 0x00) {
            const absAddr = (extendedAddress + address) & HEX_ADDR_MASK;
            for (let i = 0; i < byteCount; i++) {
                data[absAddr - minAddr + i] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
            }
        } else if (recType === 0x02) {
            extendedAddress = parseInt(line.slice(9, 13), 16) << 4;
        } else if (recType === 0x04) {
            extendedAddress = parseInt(line.slice(9, 13), 16) << 16;
        } else if (recType === 0x01) {
            break;
        }
    }

    return { offset: minAddr, data };
}

// ===== BIN Parser =====

function parseBin(buffer, offset) {
    return { offset, data: new Uint8Array(buffer) };
}

// ===== Merge =====

function buildMergedBuffer() {
    const merged   = new Uint8Array(totalSize).fill(0xFF);
    const ownerMap = new Int8Array(totalSize).fill(-1);
    const overlapMap = new Uint8Array(totalSize).fill(0);

    for (let s = 0; s < NUM_SLOTS; s++) {
        const slot = slots[s];
        if (!slot) continue;
        const { offset, data } = slot;
        for (let i = 0; i < data.length; i++) {
            const addr = offset + i;
            if (addr < 0 || addr >= totalSize) continue;
            if (ownerMap[addr] !== -1) overlapMap[addr] = 1;
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
 * @param {number} baseOffset  Added to every address (e.g. 0x08000000 for STM32)
 * @returns {string}
 */
function toIntelHex(data, baseOffset = 0) {
    const RECORD_SIZE = 16;
    const lines = [];
    let currentUpperAddr = -1;

    for (let addr = 0; addr < data.length; addr += RECORD_SIZE) {
        const absAddr   = addr + baseOffset;
        const upperAddr = (absAddr >> 16) & 0xFFFF;

        if (upperAddr !== currentUpperAddr) {
            currentUpperAddr = upperAddr;
            const hi = (upperAddr >> 8) & 0xFF;
            const lo = upperAddr & 0xFF;
            const cs = (0x100 - ((2 + 0 + 0 + 4 + hi + lo) & 0xFF)) & 0xFF;
            lines.push(`:02000004${hi.toString(16).padStart(2,'0').toUpperCase()}${lo.toString(16).padStart(2,'0').toUpperCase()}${cs.toString(16).padStart(2,'0').toUpperCase()}`);
        }

        const count  = Math.min(RECORD_SIZE, data.length - addr);
        const addrLo = absAddr & 0xFFFF;
        const aHi    = (addrLo >> 8) & 0xFF;
        const aLo    = addrLo & 0xFF;
        let sum = count + aHi + aLo;
        let dataStr = '';
        for (let i = 0; i < count; i++) {
            const b = data[addr + i];
            sum += b;
            dataStr += b.toString(16).padStart(2, '0').toUpperCase();
        }
        const cs = (0x100 - (sum & 0xFF)) & 0xFF;
        lines.push(`:${count.toString(16).padStart(2,'0').toUpperCase()}${aHi.toString(16).padStart(2,'0').toUpperCase()}${aLo.toString(16).padStart(2,'0').toUpperCase()}00${dataStr}${cs.toString(16).padStart(2,'0').toUpperCase()}`);
    }

    lines.push(':00000001FF');
    return lines.join('\r\n') + '\r\n';
}

// ===== Minimap =====

function renderMinimapCore() {
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

        let r = EMPTY_COLOR_RGB[0], g = EMPTY_COLOR_RGB[1], b = EMPTY_COLOR_RGB[2];
        let slotCounts = [0, 0, 0, 0];
        let overlapCount = 0;

        for (let i = byteStart; i < byteEnd && i < totalSize; i++) {
            if (overlapMap[i]) overlapCount++;
            else if (ownerMap[i] >= 0) slotCounts[ownerMap[i]]++;
        }

        if (overlapCount > 0) {
            hasOverlap = true;
            [r, g, b] = OVERLAP_COLOR_RGB;
        } else {
            let maxCount = 0, dominantSlot = -1;
            for (let s = 0; s < NUM_SLOTS; s++) {
                if (slotCounts[s] > maxCount) { maxCount = slotCounts[s]; dominantSlot = s; }
            }
            if (dominantSlot >= 0) [r, g, b] = SLOT_COLORS_RGB[dominantSlot];
        }

        for (let py = 0; py < H; py++) {
            const idx = (py * W + px) * 4;
            pixels[idx] = r; pixels[idx+1] = g; pixels[idx+2] = b; pixels[idx+3] = 255;
        }
    }

    minimapCtx.putImageData(imageData, 0, 0);

    if (!hasAnyFile) {
        minimapHint.textContent = 'No files loaded';
        minimapHint.style.color = '';
    } else if (hasOverlap) {
        minimapHint.textContent = '⚠ Overlap detected!';
        minimapHint.style.color = '#ff3333';
    } else {
        const loadedCount = slots.filter(s => s !== null).length;
        minimapHint.textContent = `${loadedCount} file${loadedCount > 1 ? 's' : ''} loaded`;
        minimapHint.style.color = '';
    }

    addrStart.textContent = toHex8(0);
    addrEnd.textContent   = toHex8(totalSize);
}

function renderMinimap() {
    renderMinimapCore();
    if (typeof enlargedVisible !== 'undefined' && enlargedVisible) renderEnlargedMap();
}

// ===== Minimap Tooltip =====

minimapCanvas.addEventListener('mousemove', (e) => {
    const rect = minimapCanvas.getBoundingClientRect();
    const scaleX = minimapCanvas.width / rect.width;
    const px = Math.floor((e.clientX - rect.left) * scaleX);
    const addr = Math.floor(px * (totalSize / minimapCanvas.width));

    if (addr < 0 || addr >= totalSize) { minimapTooltip.style.display = 'none'; return; }

    let ownerName = 'Empty (0xFF)', ownerColor = '#888';
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

function updateSlotUI(idx) {
    const slot         = slots[idx];
    const infoEl       = document.getElementById(`info-${idx}`);
    const nameEl       = document.getElementById(`name-${idx}`);
    const offsetDisp   = document.getElementById(`offset-display-${idx}`);
    const offsetInput  = document.getElementById(`offset-input-${idx}`);
    const sizeEl       = document.getElementById(`size-${idx}`);
    const clearBtn     = document.getElementById(`clear-${idx}`);
    const warningEl    = document.getElementById(`warning-${idx}`);
    const warningText  = document.getElementById(`warning-text-${idx}`);
    const dropZone     = document.getElementById(`drop-${idx}`);

    if (!slot) {
        infoEl.style.display  = 'none';
        clearBtn.style.display = 'none';
        dropZone.style.display = 'flex';
        return;
    }

    infoEl.style.display   = 'flex';
    clearBtn.style.display = 'flex';
    dropZone.style.display = 'none';

    nameEl.textContent = slot.name;
    sizeEl.textContent = formatSize(slot.size);

    if (slot.isBin) {
        offsetDisp.style.display  = 'none';
        offsetInput.style.display = 'inline-block';
        offsetInput.value = toHex8(slot.offset);
    } else {
        offsetDisp.style.display  = 'inline';
        offsetInput.style.display = 'none';
        offsetDisp.textContent = toHex8(slot.offset);
    }

    const warnings = [];
    if (slot.offset + slot.size > totalSize) warnings.push(`⚠ Exceeds total size (${toHex8(totalSize)})`);
    if (slot.offset < 0) warnings.push('⚠ Negative offset');

    if (warnings.length > 0) {
        warningEl.style.display = 'flex';
        warningText.textContent = warnings.join(' | ');
    } else {
        warningEl.style.display = 'none';
    }
}

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
 * Process a list of files starting from slot `startIdx`, filling consecutive slots.
 * @param {number} startIdx
 * @param {File[]} files
 */
async function processFileList(startIdx, files) {
    for (let i = 0; i < files.length; i++) {
        const slotIdx = startIdx + i;
        if (slotIdx >= NUM_SLOTS) break; // no more slots available
        // Ensure the slot card exists in the DOM
        while (renderedSlotCount <= slotIdx) {
            createSlotCard(renderedSlotCount);
        }
        await processFile(slotIdx, files[i]);
    }
}

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
        ensureTrailingEmptySlot();
        renderMinimap();
        updateDownloadButtons();

    } catch (err) {
        showSlotError(idx, `Parse error: ${err.message}`);
    }
}

function showSlotError(idx, msg) {
    const warningEl   = document.getElementById(`warning-${idx}`);
    const warningText = document.getElementById(`warning-text-${idx}`);
    const infoEl      = document.getElementById(`info-${idx}`);
    infoEl.style.display    = 'flex';
    warningEl.style.display = 'flex';
    warningText.textContent = msg;
}

// ===== Total Size Selector =====

document.querySelectorAll('input[name="totalSize"]').forEach(radio => {
    radio.addEventListener('change', () => {
        totalSize = parseInt(radio.value);
        const kb = totalSize / 1024;
        sizeInfo.textContent = `${kb} KB = ${toHex8(totalSize)} bytes`;
        for (let i = 0; i < renderedSlotCount; i++) updateSlotUI(i);
        renderMinimap();
        updateDownloadButtons();
    });
});

// ===== Download =====

function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
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
    const stm32Cb = document.getElementById('stm32BaseAddr');
    const baseOffset = stm32Cb && stm32Cb.checked ? STM32_BASE : 0;
    triggerDownload(new TextEncoder().encode(toIntelHex(merged, baseOffset)), 'merged.hex', 'text/plain');
});

// ===== Enlarged Byte View =====

const enlargedSection = document.getElementById('enlargedSection');
const enlargedCanvas  = document.getElementById('enlargedMap');
const enlargedCtx     = enlargedCanvas.getContext('2d');
const enlargedWrap    = document.getElementById('enlargedWrap');
const enlargedStatus  = document.getElementById('enlargedStatus');
const expandBtn       = document.getElementById('expandBtn');

let enlargedVisible = false;

// Bytes per row in the enlarged view (fixed width = container width / 1px per byte)
const ENLARGED_BYTES_PER_ROW = 256;

/**
 * Render the enlarged byte-level view.
 * Each pixel = 1 byte. Brightness = byte value (0x00=black, 0xFF=white).
 * Tinted by slot color. Empty (0xFF) shown as dark background color.
 */
function renderEnlargedMap() {
    if (!enlargedVisible) return;

    const { merged, ownerMap } = buildMergedBuffer();
    const rows = Math.ceil(totalSize / ENLARGED_BYTES_PER_ROW);
    const W = ENLARGED_BYTES_PER_ROW;
    const H = rows;

    enlargedCanvas.width  = W;
    enlargedCanvas.height = H;

    const imageData = enlargedCtx.createImageData(W, H);
    const pixels = imageData.data;

    for (let i = 0; i < totalSize; i++) {
        const val   = merged[i];
        const owner = ownerMap[i];
        const px    = i % W;
        const py    = Math.floor(i / W);
        const idx4  = (py * W + px) * 4;

        if (owner < 0) {
            // Empty — dark background
            pixels[idx4]     = EMPTY_COLOR_RGB[0];
            pixels[idx4 + 1] = EMPTY_COLOR_RGB[1];
            pixels[idx4 + 2] = EMPTY_COLOR_RGB[2];
            pixels[idx4 + 3] = 255;
        } else {
            // Tint slot color by byte brightness
            // brightness t = val/255; color = slot_color * t (so 0x00=black, 0xFF=full slot color)
            const t = val / 255;
            const sc = SLOT_COLORS_RGB[owner];
            pixels[idx4]     = Math.round(sc[0] * t);
            pixels[idx4 + 1] = Math.round(sc[1] * t);
            pixels[idx4 + 2] = Math.round(sc[2] * t);
            pixels[idx4 + 3] = 255;
        }
    }

    enlargedCtx.putImageData(imageData, 0, 0);
}

// Toggle enlarged view
expandBtn.addEventListener('click', () => {
    enlargedVisible = !enlargedVisible;
    enlargedSection.style.display = enlargedVisible ? 'block' : 'none';
    expandBtn.textContent = enlargedVisible ? '⤡ Collapse' : '⤢ Expand';
    expandBtn.classList.toggle('active', enlargedVisible);
    if (enlargedVisible) renderEnlargedMap();
});

// Mouse hover on enlarged canvas — show address + value in status bar
enlargedCanvas.addEventListener('mousemove', (e) => {
    const rect   = enlargedCanvas.getBoundingClientRect();
    const scaleX = enlargedCanvas.width  / rect.width;
    const scaleY = enlargedCanvas.height / rect.height;
    const px = Math.floor((e.clientX - rect.left) * scaleX);
    const py = Math.floor((e.clientY - rect.top)  * scaleY);
    const addr = py * ENLARGED_BYTES_PER_ROW + px;

    if (addr < 0 || addr >= totalSize) {
        enlargedStatus.textContent = 'Hover over the map to inspect bytes';
        return;
    }

    const { merged, ownerMap } = buildMergedBuffer();
    const val   = merged[addr];
    const owner = ownerMap[addr];

    let slotInfo = 'Empty';
    let colorStyle = '';
    if (owner >= 0 && slots[owner]) {
        slotInfo = `Slot ${owner + 1}: ${slots[owner].name}`;
        colorStyle = `color:${SLOT_COLORS_HEX[owner]}`;
    }

    enlargedStatus.innerHTML =
        `Address: <b>${toHex8(addr)}</b> (${addr.toLocaleString()}) &nbsp;|&nbsp; ` +
        `Value: <b>0x${val.toString(16).toUpperCase().padStart(2,'0')}</b> (${val}) &nbsp;|&nbsp; ` +
        `<span style="${colorStyle}">${slotInfo}</span>`;
});

enlargedCanvas.addEventListener('mouseleave', () => {
    enlargedStatus.textContent = 'Hover over the map to inspect bytes';
});

// ===== Init =====
// Start with 1 empty slot
createSlotCard(0);
renderMinimap();
updateDownloadButtons();

// Set initial size info label
sizeInfo.textContent = `${totalSize / 1024} KB = ${toHex8(totalSize)} bytes`;
