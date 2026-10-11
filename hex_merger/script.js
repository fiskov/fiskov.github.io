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
const GAP_COLOR_RGB = [12, 12, 24];
const NUM_SLOTS = 4;

// ===== State =====
/** @type {Array<{name:string, offset:number, size:number, segments:Array<{addr:number, data:Uint8Array}>, isBin:boolean, isMicrochip:boolean}|null>} */
const slots = new Array(NUM_SLOTS).fill(null);
let totalSize = 512 * 1024; // default 512 KB
let renderedSlotCount = 0;  // how many slot cards exist in the DOM

// ===== Constants =====
const STM32_BASE = 0x08000000; // STM32 flash base address
const EM_DSPIC30F = 118;      // e_machine of XC16 PIC24/dsPIC ELF files

const MCHP_EEPROM_BASE = 0x00FFFC00;
const MCHP_EEPROM_SIZE = 0x400;
const MCHP_CONFIG_BASE = 0x01F00000;
const MCHP_CONFIG_SIZE = 0x200;

// ===== DOM References =====
const slotsGrid      = document.getElementById('slots-grid');
const minimapCanvas  = document.getElementById('minimap');
const minimapCtx     = minimapCanvas.getContext('2d');
const minimapTooltip = document.getElementById('minimapTooltip');
const minimapHint    = document.getElementById('minimapHint');
const addrStart      = document.getElementById('addrStart');
const addrEnd        = document.getElementById('addrEnd');
const regionLabels   = document.getElementById('regionLabels');
const downloadBinBtn = document.getElementById('downloadBin');
const downloadHexBtn = document.getElementById('downloadHex');
const actionInfo     = document.getElementById('actionInfo');
const sizeInfo       = document.getElementById('sizeInfo');

let minimapLayout = []; // [{x0, x1, region}] filled by renderMinimapCore
let enlargedLayout = null; // filled by renderEnlargedMap

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

function isMicrochipMode() {
    return slots.some(s => s && s.isMicrochip);
}

function getRegions() {
    if (!isMicrochipMode()) {
        return [{ id: 'flash', name: 'FLASH', base: 0, size: totalSize }];
    }
    const flashSize = Math.min(totalSize, MCHP_EEPROM_BASE);
    return [
        { id: 'flash',  name: 'FLASH',  base: 0,               size: flashSize },
        { id: 'eeprom', name: 'EEPROM', base: MCHP_EEPROM_BASE, size: MCHP_EEPROM_SIZE },
        { id: 'config', name: 'CONFIG', base: MCHP_CONFIG_BASE, size: MCHP_CONFIG_SIZE }
    ];
}

function regionHasData(region) {
    return slots.some(s => s && s.segments.some(seg => {
        return seg.addr < region.base + region.size && seg.addr + seg.data.length > region.base;
    }));
}

function getVisibleRegions() {
    const regions = getRegions();
    return regions.filter(r => r.id === 'flash' || regionHasData(r));
}

function segmentBytesInRegion(seg, region) {
    const start = Math.max(seg.addr, region.base);
    const end = Math.min(seg.addr + seg.data.length, region.base + region.size);
    return Math.max(0, end - start);
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
                <p class="drop-text">Drop .hex, .elf or .bin file</p>
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
            <div class="info-row segments-row" id="segments-row-${idx}" style="display:none">
                <span class="info-label">🗺 Map</span>
                <span class="info-value segments-value" id="segments-${idx}">—</span>
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
        input.accept = '.hex,.elf,.bin';
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
        if (slot.segments.length > 0) slot.segments[0].addr = val;
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

function coalesceSegments(entries) {
    entries.sort((a, b) => a.addr - b.addr);

    const segments = [];
    for (const e of entries) {
        const last = segments[segments.length - 1];
        if (last && e.addr <= last.addr + last.data.length) {
            const writePos = e.addr - last.addr;
            const need = writePos + e.data.length;
            if (need > last.data.length) {
                const grown = new Uint8Array(need);
                grown.set(last.data);
                last.data = grown;
            }
            last.data.set(e.data, writePos);
        } else {
            segments.push({ addr: e.addr, data: e.data });
        }
    }
    return segments;
}

function parseIntelHex(buffer) {
    const text = new TextDecoder('ascii').decode(buffer);
    const lines = text.split(/\r?\n/);

    let extendedAddress = 0;
    let isMicrochip = false;
    const entries = [];

    for (const line of lines) {
        if (!line.startsWith(':')) continue;
        const byteCount = parseInt(line.slice(1, 3), 16);
        const address   = parseInt(line.slice(3, 7), 16);
        const recType   = parseInt(line.slice(7, 9), 16);

        if (recType === 0x00) {
            let absAddr = extendedAddress + address;
            if ((absAddr & 0xFF000000) === STM32_BASE) absAddr -= STM32_BASE;
            const bytes = new Uint8Array(byteCount);
            for (let i = 0; i < byteCount; i++) {
                bytes[i] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
            }
            entries.push({ addr: absAddr, data: bytes });
            if (absAddr >= MCHP_EEPROM_BASE && absAddr < 0x01000000) isMicrochip = true;
            if (absAddr >= MCHP_CONFIG_BASE && absAddr < 0x02000000) isMicrochip = true;
        } else if (recType === 0x02) {
            extendedAddress = parseInt(line.slice(9, 13), 16) << 4;
        } else if (recType === 0x04) {
            extendedAddress = parseInt(line.slice(9, 13), 16) << 16;
        } else if (recType === 0x01) {
            break;
        }
    }

    if (entries.length === 0) throw new Error('No data records found in HEX file');

    return { segments: coalesceSegments(entries), isMicrochip };
}

// ===== ELF Parser =====

function parseElf(buffer) {
    const u8 = new Uint8Array(buffer);
    if (u8.length < 52 || u8[0] !== 0x7F || u8[1] !== 0x45 || u8[2] !== 0x4C || u8[3] !== 0x46) {
        throw new Error('Not an ELF file');
    }

    const is64 = u8[4] === 2;
    const little = u8[5] !== 2;
    const dv = new DataView(buffer);
    const rd16 = (o) => dv.getUint16(o, little);
    const rd32 = (o) => dv.getUint32(o, little);

    const e_machine = rd16(18);
    const isMicrochip = e_machine === EM_DSPIC30F;

    let phoff, phentsize, phnum, shoff, shentsize, shnum;
    if (is64) {
        phoff = rd32(32);
        phentsize = rd16(54);
        phnum = rd16(56);
        shoff = rd32(40);
        shentsize = rd16(58);
        shnum = rd16(60);
    } else {
        phoff = rd32(28);
        phentsize = rd16(42);
        phnum = rd16(44);
        shoff = rd32(32);
        shentsize = rd16(46);
        shnum = rd16(48);
    }

    const toHexAddr = (lma) => {
        let addr = lma;
        if (isMicrochip) {
            addr *= 2;
        } else if ((addr & 0xFF000000) === STM32_BASE) {
            addr -= STM32_BASE;
        }
        return addr;
    };

    const loads = [];
    for (let i = 0; i < phnum; i++) {
        const ph = phoff + i * phentsize;
        if (ph + (is64 ? 56 : 32) > u8.length) break;

        let p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz;
        if (is64) {
            p_type   = rd32(ph);
            p_offset = rd32(ph + 8);
            p_vaddr  = rd32(ph + 16);
            p_paddr  = rd32(ph + 24);
            p_filesz = rd32(ph + 32);
            p_memsz  = rd32(ph + 40);
        } else {
            p_type   = rd32(ph);
            p_offset = rd32(ph + 4);
            p_vaddr  = rd32(ph + 8);
            p_paddr  = rd32(ph + 12);
            p_filesz = rd32(ph + 16);
            p_memsz  = rd32(ph + 20);
        }

        if (p_type !== 1 || p_filesz === 0) continue;
        if (p_offset + p_filesz > u8.length) continue;
        loads.push({ p_offset, p_vaddr, p_paddr, p_filesz, p_memsz });
    }

    const entries = [];

    for (let i = 0; i < shnum; i++) {
        const sh = shoff + i * shentsize;
        if (sh + (is64 ? 64 : 40) > u8.length) break;

        let sh_type, sh_flags, sh_addr, sh_offset, sh_size;
        if (is64) {
            sh_type   = rd32(sh + 4);
            sh_flags  = rd32(sh + 8);
            sh_addr   = rd32(sh + 16);
            sh_offset = rd32(sh + 24);
            sh_size   = rd32(sh + 32);
        } else {
            sh_type   = rd32(sh + 4);
            sh_flags  = rd32(sh + 8);
            sh_addr   = rd32(sh + 12);
            sh_offset = rd32(sh + 16);
            sh_size   = rd32(sh + 20);
        }

        if (sh_type === 0 || sh_type === 8) continue;
        if ((sh_flags & 0x2) === 0) continue;
        if (sh_size === 0 || sh_offset + sh_size > u8.length) continue;

        let lma = null;
        for (const seg of loads) {
            if (sh_offset >= seg.p_offset && sh_offset < seg.p_offset + seg.p_filesz) {
                lma = seg.p_paddr + (sh_addr - seg.p_vaddr);
                break;
            }
        }
        if (lma === null) continue;
        entries.push({ addr: toHexAddr(lma), data: u8.slice(sh_offset, sh_offset + sh_size) });
    }

    if (entries.length === 0) {
        for (const seg of loads) {
            const lma = (seg.p_paddr !== 0 || seg.p_vaddr === 0) ? seg.p_paddr : seg.p_vaddr;
            entries.push({ addr: toHexAddr(lma), data: u8.slice(seg.p_offset, seg.p_offset + seg.p_filesz) });
        }
    }

    if (entries.length === 0) throw new Error('No loadable segments in ELF file');

    return { segments: coalesceSegments(entries), isMicrochip };
}

// ===== BIN Parser =====

function parseBin(buffer, offset) {
    return { segments: [{ addr: offset, data: new Uint8Array(buffer) }], isMicrochip: false };
}

// ===== Merge =====

function getFillerByte() {
    const input = document.getElementById('fillerByteInput');
    if (!input) return 0xFF;
    const val = parseHexInput(input.value);
    return (isNaN(val) || val < 0 || val > 255) ? 0xFF : val;
}

function buildMergedRegions() {
    const filler = getFillerByte();
    return getRegions().map(r => {
        const region = {
            id: r.id,
            name: r.name,
            base: r.base,
            size: r.size,
            merged: new Uint8Array(r.size).fill(filler),
            ownerMap: new Int8Array(r.size).fill(-1),
            overlapMap: new Uint8Array(r.size).fill(0)
        };

        for (let s = 0; s < NUM_SLOTS; s++) {
            const slot = slots[s];
            if (!slot) continue;
            for (const seg of slot.segments) {
                const start = Math.max(seg.addr, region.base);
                const end = Math.min(seg.addr + seg.data.length, region.base + region.size);
                for (let addr = start; addr < end; addr++) {
                    const idx = addr - region.base;
                    if (region.ownerMap[idx] !== -1) region.overlapMap[idx] = 1;
                    region.merged[idx] = seg.data[addr - seg.addr];
                    region.ownerMap[idx] = s;
                }
            }
        }
        return region;
    });
}

function regionOwnedBytes(region) {
    for (let i = 0; i < region.ownerMap.length; i++) {
        if (region.ownerMap[i] >= 0) return true;
    }
    return false;
}

// ===== Intel HEX Export =====

function toIntelHex(segments, baseOffset = 0) {
    const RECORD_SIZE = 16;
    const lines = [];
    let currentUpperAddr = -1;

    for (const seg of segments) {
        for (let addr = 0; addr < seg.data.length; addr += RECORD_SIZE) {
            const absAddr   = seg.addr + addr + baseOffset;
            const upperAddr = (absAddr >> 16) & 0xFFFF;

            if (upperAddr !== currentUpperAddr) {
                currentUpperAddr = upperAddr;
                const hi = (upperAddr >> 8) & 0xFF;
                const lo = upperAddr & 0xFF;
                const cs = (0x100 - ((2 + 0 + 0 + 4 + hi + lo) & 0xFF)) & 0xFF;
                lines.push(`:02000004${hi.toString(16).padStart(2,'0').toUpperCase()}${lo.toString(16).padStart(2,'0').toUpperCase()}${cs.toString(16).padStart(2,'0').toUpperCase()}`);
            }

            const count  = Math.min(RECORD_SIZE, seg.data.length - addr);
            const addrLo = absAddr & 0xFFFF;
            const aHi    = (addrLo >> 8) & 0xFF;
            const aLo    = addrLo & 0xFF;
            let sum = count + aHi + aLo;
            let dataStr = '';
            for (let i = 0; i < count; i++) {
                const b = seg.data[addr + i];
                sum += b;
                dataStr += b.toString(16).padStart(2, '0').toUpperCase();
            }
            const cs = (0x100 - (sum & 0xFF)) & 0xFF;
            lines.push(`:${count.toString(16).padStart(2,'0').toUpperCase()}${aHi.toString(16).padStart(2,'0').toUpperCase()}${aLo.toString(16).padStart(2,'0').toUpperCase()}00${dataStr}${cs.toString(16).padStart(2,'0').toUpperCase()}`);
        }
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

    const regionData = buildMergedRegions();
    const visible = getVisibleRegions().map(r => regionData.find(x => x.id === r.id));
    const panelCount = visible.length;
    const gap = panelCount > 1 ? 4 : 0;
    const panelW = Math.floor((W - gap * (panelCount - 1)) / panelCount);

    minimapLayout = [];
    let hasAnyFile = slots.some(s => s !== null);
    let hasOverlap = false;

    for (let i = 0; i < W * H; i++) {
        pixels[i * 4] = GAP_COLOR_RGB[0];
        pixels[i * 4 + 1] = GAP_COLOR_RGB[1];
        pixels[i * 4 + 2] = GAP_COLOR_RGB[2];
        pixels[i * 4 + 3] = 255;
    }

    for (let ri = 0; ri < panelCount; ri++) {
        const region = visible[ri];
        const x0 = ri * (panelW + gap);
        minimapLayout.push({ x0, x1: x0 + panelW, region });

        for (let px = 0; px < panelW; px++) {
            const byteStart = Math.floor(px * (region.size / panelW));
            const byteEnd   = Math.floor((px + 1) * (region.size / panelW));

            let r = EMPTY_COLOR_RGB[0], g = EMPTY_COLOR_RGB[1], b = EMPTY_COLOR_RGB[2];
            let slotCounts = [0, 0, 0, 0];
            let overlapCount = 0;

            for (let i = byteStart; i < byteEnd && i < region.size; i++) {
                if (region.overlapMap[i]) overlapCount++;
                else if (region.ownerMap[i] >= 0) slotCounts[region.ownerMap[i]]++;
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
                const idx = (py * W + x0 + px) * 4;
                pixels[idx] = r; pixels[idx+1] = g; pixels[idx+2] = b; pixels[idx+3] = 255;
            }
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
        const modeNote = isMicrochipMode() ? ' · Microchip XC16' : '';
        minimapHint.textContent = `${loadedCount} file${loadedCount > 1 ? 's' : ''} loaded${modeNote}`;
        minimapHint.style.color = '';
    }

    if (isMicrochipMode()) {
        addrStart.style.display = 'none';
        addrEnd.style.display = 'none';
        regionLabels.style.display = 'flex';
        regionLabels.innerHTML = minimapLayout.map(p => {
            const end = p.region.base + p.region.size - 1;
            return `<span class="minimap-region-label"><b>${p.region.name}</b> ${toHex8(p.region.base)}–${toHex8(end)}</span>`;
        }).join('');
    } else {
        addrStart.style.display = '';
        addrEnd.style.display = '';
        regionLabels.style.display = 'none';
        addrStart.textContent = toHex8(0);
        addrEnd.textContent   = toHex8(totalSize);
    }
}

function renderMinimap() {
    renderMinimapCore();
    updateModeUI();
    if (typeof enlargedVisible !== 'undefined' && enlargedVisible) renderEnlargedMap();
}

function updateModeUI() {
    const microchip = isMicrochipMode();
    const stm32Cb = document.getElementById('stm32BaseAddr');
    const unpackCb = document.getElementById('unpackWords');
    if (stm32Cb) {
        stm32Cb.disabled = microchip;
        stm32Cb.closest('label').style.opacity = microchip ? 0.5 : 1;
    }
    if (unpackCb) {
        unpackCb.disabled = !microchip;
        unpackCb.closest('label').style.opacity = microchip ? 1 : 0.5;
    }
}

// ===== Minimap Tooltip =====

minimapCanvas.addEventListener('mousemove', (e) => {
    const rect = minimapCanvas.getBoundingClientRect();
    const scaleX = minimapCanvas.width / rect.width;
    const px = Math.floor((e.clientX - rect.left) * scaleX);

    let panel = minimapLayout.find(p => px >= p.x0 && px < p.x1);
    if (!panel) { minimapTooltip.style.display = 'none'; return; }

    const innerPx = px - panel.x0;
    const panelW = panel.x1 - panel.x0;
    const addr = panel.region.base + Math.floor(innerPx * (panel.region.size / panelW));

    let ownerName = 'Empty (0xFF)', ownerColor = '#888';
    for (let s = 0; s < NUM_SLOTS; s++) {
        const slot = slots[s];
        if (!slot) continue;
        if (slot.segments.some(seg => addr >= seg.addr && addr < seg.addr + seg.data.length)) {
            ownerName = `Slot ${s + 1}: ${slot.name}`;
            ownerColor = SLOT_COLORS_HEX[s];
            break;
        }
    }

    const regionTag = isMicrochipMode() ? `<br>${panel.region.name}` : '';
    minimapTooltip.innerHTML = `<span style="color:${ownerColor}">${ownerName}</span>${regionTag}<br>${toHex8(addr)}`;
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
    const segmentsRow  = document.getElementById(`segments-row-${idx}`);
    const segmentsEl   = document.getElementById(`segments-${idx}`);
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

    if (slot.segments.length > 1 || slot.isMicrochip) {
        segmentsRow.style.display = 'flex';
        segmentsEl.textContent = slot.segments.map(seg => {
            return `${toHex8(seg.addr)}..${toHex8(seg.addr + seg.data.length - 1)}`;
        }).join(', ');
    } else {
        segmentsRow.style.display = 'none';
    }

    const warnings = [];
    const regions = getRegions();
    for (const seg of slot.segments) {
        let covered = 0;
        for (const r of regions) covered += segmentBytesInRegion(seg, r);
        if (covered < seg.data.length) {
            if (isMicrochipMode()) {
                warnings.push(`⚠ ${seg.data.length - covered} bytes outside FLASH/EEPROM/CONFIG map`);
            } else {
                warnings.push(`⚠ Exceeds total size (${toHex8(totalSize)})`);
            }
        }
    }
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
    const isElf = ext === 'elf';

    if (!isBin && !isHex && !isElf) {
        showSlotError(idx, `Unsupported file type ".${ext}". Use .hex, .elf or .bin`);
        return;
    }

    try {
        const buffer = await file.arrayBuffer();
        let parsed;

        if (isHex) {
            parsed = parseIntelHex(buffer);
        } else if (isElf) {
            parsed = parseElf(buffer);
        } else {
            const existingOffset = slots[idx]?.isBin ? slots[idx].offset : 0;
            parsed = parseBin(buffer, existingOffset);
        }

        const size = parsed.segments.reduce((n, seg) => n + seg.data.length, 0);

        slots[idx] = {
            name: file.name,
            offset: parsed.segments[0].addr,
            size,
            segments: parsed.segments,
            isBin,
            isMicrochip: parsed.isMicrochip
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

function getOutputName() {
    const input = document.getElementById('outputNameInput');
    const name = input ? input.value.trim() : '';
    return name.length > 0 ? name : 'merged';
}

function unpackWords(data) {
    const nWords = Math.floor(data.length / 4);
    const out = new Uint8Array(nWords * 3);
    for (let w = 0; w < nWords; w++) {
        out[w * 3]     = data[w * 4];
        out[w * 3 + 1] = data[w * 4 + 1];
        out[w * 3 + 2] = data[w * 4 + 2];
    }
    return out;
}

function isUnpackEnabled() {
    const cb = document.getElementById('unpackWords');
    return !!(cb && cb.checked && isMicrochipMode());
}

/**
 * If the "Trim" checkbox is checked, strip trailing filler bytes then
 * pad the result up to the next 8-byte boundary (filled with filler byte).
 * @param {Uint8Array} merged
 * @returns {Uint8Array}
 */
function applyTrim(merged) {
    const trimCb = document.getElementById('trimBin');
    if (!trimCb || !trimCb.checked) return merged;
    const filler = getFillerByte();
    let end = merged.length;
    while (end > 0 && merged[end - 1] === filler) end--;
    // Round up to 8-byte alignment
    const aligned = (end + 7) & ~7;
    const result = new Uint8Array(aligned).fill(filler);
    result.set(merged.subarray(0, end));
    return result;
}

downloadBinBtn.addEventListener('click', () => {
    const regionData = buildMergedRegions();
    const flash = regionData[0];
    let data = flash.merged;
    if (isUnpackEnabled()) data = unpackWords(data);
    data = applyTrim(data);
    triggerDownload(data, `${getOutputName()}.bin`, 'application/octet-stream');
});

downloadHexBtn.addEventListener('click', () => {
    const regionData = buildMergedRegions();
    const segments = [];
    for (const region of regionData) {
        if (!regionOwnedBytes(region)) continue;
        segments.push({ addr: region.base, data: applyTrim(region.merged) });
    }
    if (segments.length === 0) segments.push({ addr: 0, data: new Uint8Array(0) });
    const stm32Cb = document.getElementById('stm32BaseAddr');
    const baseOffset = (!isMicrochipMode() && stm32Cb && stm32Cb.checked) ? STM32_BASE : 0;
    triggerDownload(new TextEncoder().encode(toIntelHex(segments, baseOffset)), `${getOutputName()}.hex`, 'text/plain');
});

// Filler byte input — validate and re-render minimap on change
document.getElementById('fillerByteInput').addEventListener('input', function () {
    const val = parseHexInput(this.value);
    const valid = !isNaN(val) && val >= 0 && val <= 255;
    this.classList.toggle('invalid', !valid);
    if (valid) renderMinimap();
});

// Unpack words — re-render views on change
document.getElementById('unpackWords').addEventListener('change', function () {
    renderMinimap();
});

// ===== Enlarged Byte View =====

const enlargedSection    = document.getElementById('enlargedSection');
const enlargedCanvas     = document.getElementById('enlargedMap');
const enlargedCtx        = enlargedCanvas.getContext('2d');
const enlargedWrap       = document.getElementById('enlargedWrap');
const enlargedStatus     = document.getElementById('enlargedStatus');
const enlargedHint       = document.getElementById('enlargedHint');
const expandBtn          = document.getElementById('expandBtn');
const pixelSizeSelect    = document.getElementById('pixelSizeSelect');
const bytesPerRowSelect  = document.getElementById('bytesPerRowSelect');

let enlargedVisible  = false;
let enlargedPixelSize   = parseInt(pixelSizeSelect.value);   // px per byte (1–4)
let enlargedBytesPerRow = parseInt(bytesPerRowSelect.value); // bytes per row

function updateEnlargedHint() {
    const unpackNote = isMicrochipMode()
        ? (isUnpackEnabled() ? ' &nbsp;|&nbsp; 24-bit words unpacked (3 B)' : ' &nbsp;|&nbsp; 4 B HEX slots')
        : '';
    enlargedHint.innerHTML =
        `Each pixel = ${enlargedPixelSize} px &nbsp;|&nbsp; ` +
        `${enlargedBytesPerRow} bytes/row &nbsp;|&nbsp; ` +
        `brightness = value (0x00=black, 0xFF=white) &nbsp;|&nbsp; tinted by slot color` +
        unpackNote;
}

function buildVirtualImage() {
    const regionData = buildMergedRegions();
    const unpack = isUnpackEnabled();
    const chunks = [];

    for (const region of regionData) {
        let data = region.merged;
        let owner = region.ownerMap;
        const realAddrs = new Int32Array(data.length);

        if (unpack && (region.id === 'flash' || region.id === 'config')) {
            const nWords = Math.floor(data.length / 4);
            const nd = new Uint8Array(nWords * 3);
            const no = new Int8Array(nWords * 3);
            const na = new Int32Array(nWords * 3);
            for (let w = 0; w < nWords; w++) {
                for (let b = 0; b < 3; b++) {
                    nd[w * 3 + b] = data[w * 4 + b];
                    no[w * 3 + b] = owner[w * 4 + b];
                    na[w * 3 + b] = region.base + w * 4 + b;
                }
            }
            data = nd; owner = no;
            for (let i = 0; i < na.length; i++) realAddrs[i] = na[i];
        } else {
            for (let i = 0; i < data.length; i++) realAddrs[i] = region.base + i;
        }

        if (data.length > 0) chunks.push({ region, data, owner, realAddrs });
    }

    return chunks;
}

/**
 * Render the enlarged byte-level view.
 * Each byte is rendered as a (enlargedPixelSize × enlargedPixelSize) block.
 * Brightness = byte value (0x00=black, 0xFF=white). Tinted by slot color.
 * Empty (0xFF) shown as dark background color.
 */
function renderEnlargedMap() {
    if (!enlargedVisible) return;

    const chunks = buildVirtualImage();
    const BPR  = enlargedBytesPerRow;
    const PS   = enlargedPixelSize;

    let totalBytes = 0;
    for (const c of chunks) totalBytes += Math.ceil(c.data.length / BPR) * BPR;
    const rows = Math.max(1, Math.ceil(totalBytes / BPR));
    const W    = BPR * PS;
    const H    = rows * PS;

    enlargedCanvas.width  = W;
    enlargedCanvas.height = H;

    const imageData = enlargedCtx.createImageData(W, H);
    const pixels    = imageData.data;

    const dataArr   = new Uint8Array(totalBytes);
    const ownerArr  = new Int8Array(totalBytes).fill(-1);
    const realArr   = new Int32Array(totalBytes).fill(-1);
    const regionArr = new Array(totalBytes).fill(null);

    let virt = 0;
    for (const chunk of chunks) {
        for (let i = 0; i < chunk.data.length; i++) {
            dataArr[virt]   = chunk.data[i];
            ownerArr[virt]  = chunk.owner[i];
            realArr[virt]   = chunk.realAddrs[i];
            regionArr[virt] = chunk.region.name;
            virt++;
        }
        virt = Math.ceil(virt / BPR) * BPR;
    }

    for (let i = 0; i < totalBytes; i++) {
        const val   = dataArr[i];
        const owner = ownerArr[i];
        const byteCol = i % BPR;
        const byteRow = Math.floor(i / BPR);

        let r, g, b;
        if (owner < 0) {
            r = EMPTY_COLOR_RGB[0];
            g = EMPTY_COLOR_RGB[1];
            b = EMPTY_COLOR_RGB[2];
        } else {
            const t  = val / 255;
            const sc = SLOT_COLORS_RGB[owner];
            r = Math.round(sc[0] * t);
            g = Math.round(sc[1] * t);
            b = Math.round(sc[2] * t);
        }

        for (let dy = 0; dy < PS; dy++) {
            for (let dx = 0; dx < PS; dx++) {
                const px   = byteCol * PS + dx;
                const py   = byteRow * PS + dy;
                const idx4 = (py * W + px) * 4;
                pixels[idx4]     = r;
                pixels[idx4 + 1] = g;
                pixels[idx4 + 2] = b;
                pixels[idx4 + 3] = 255;
            }
        }
    }

    enlargedCtx.putImageData(imageData, 0, 0);
    enlargedLayout = { dataArr, ownerArr, realArr, regionArr, totalBytes };
}

// Toggle enlarged view
expandBtn.addEventListener('click', () => {
    enlargedVisible = !enlargedVisible;
    enlargedSection.style.display = enlargedVisible ? 'block' : 'none';
    expandBtn.textContent = enlargedVisible ? '⤡ Collapse' : '⤢ Expand';
    expandBtn.classList.toggle('active', enlargedVisible);
    if (enlargedVisible) {
        updateEnlargedHint();
        renderEnlargedMap();
    }
});

// Pixel size combobox
pixelSizeSelect.addEventListener('change', () => {
    enlargedPixelSize = parseInt(pixelSizeSelect.value);
    updateEnlargedHint();
    renderEnlargedMap();
});

// Bytes-per-row combobox
bytesPerRowSelect.addEventListener('change', () => {
    enlargedBytesPerRow = parseInt(bytesPerRowSelect.value);
    updateEnlargedHint();
    renderEnlargedMap();
});

// Mouse hover on enlarged canvas — show address + value in status bar
enlargedCanvas.addEventListener('mousemove', (e) => {
    const rect   = enlargedCanvas.getBoundingClientRect();
    const scaleX = enlargedCanvas.width  / rect.width;
    const scaleY = enlargedCanvas.height / rect.height;
    const canvasX = Math.floor((e.clientX - rect.left) * scaleX);
    const canvasY = Math.floor((e.clientY - rect.top)  * scaleY);
    const byteCol = Math.floor(canvasX / enlargedPixelSize);
    const byteRow = Math.floor(canvasY / enlargedPixelSize);
    const addr    = byteRow * enlargedBytesPerRow + byteCol;

    if (!enlargedLayout || addr < 0 || addr >= enlargedLayout.totalBytes || enlargedLayout.realArr[addr] < 0) {
        enlargedStatus.textContent = 'Hover over the map to inspect bytes';
        return;
    }

    const val   = enlargedLayout.dataArr[addr];
    const owner = enlargedLayout.ownerArr[addr];
    const realAddr = enlargedLayout.realArr[addr];
    const regionName = enlargedLayout.regionArr[addr];

    let slotInfo = 'Empty';
    let colorStyle = '';
    if (owner >= 0 && slots[owner]) {
        slotInfo = `Slot ${owner + 1}: ${slots[owner].name}`;
        colorStyle = `color:${SLOT_COLORS_HEX[owner]}`;
    }

    const addrLabel = regionName ? `${regionName} ${toHex8(realAddr)}` : toHex8(realAddr);
    enlargedStatus.innerHTML =
        `Address: <b>${addrLabel}</b> (${realAddr.toLocaleString()}) &nbsp;|&nbsp; ` +
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
