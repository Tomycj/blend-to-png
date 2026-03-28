// ── Encode: file → .png ──────────────────────────────────────────────────────

document.getElementById('button-1').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = e => encodeFile(e.target.files[0]);
    input.click();
});

async function encodeFile(file) {
    const srcBytes  = new Uint8Array(await file.arrayBuffer());
    const dataSize  = srcBytes.length;
    
    // First 4 bytes of pixel data store the original file size,
    // so total payload = 4 (size header) + dataSize bytes
    const totalPayloadBytes = 4 + dataSize;
    const totalPixels       = Math.ceil(totalPayloadBytes / 4); // 4 bytes per pixel (RGBA)
    
    const width  = Math.ceil(Math.sqrt(totalPixels) / 4) * 4;  // multiple of 4 pixels
    const height = Math.ceil(totalPixels / width);
    
    // Raw data stream = rows of [1 filter byte] + [width * 4 pixel bytes]
    const rowSize       = 1 + width * 4;                        // 1 filter byte + pixel data
    const rawStreamSize = rowSize * height;
    const rawStream     = new Uint8Array(rawStreamSize);        // zero-initialized
    
    // Write filter byte 0x00 at the start of each row
    for (let row = 0; row < height; row++) {
        rawStream[row * rowSize] = 0x00;
    }
    
    // Helper: write into pixel data area, skipping filter bytes
    function writePixelByte(index, value) {
        const row = Math.floor(index / (width * 4));
        const col = index % (width * 4);
        rawStream[row * rowSize + 1 + col] = value;
    }
    
    // First 4 bytes: original file size (big-endian, to match PNG convention)
    new DataView(rawStream.buffer).setUint32(
        1,    // offset 1 because byte 0 of row 0 is the filter byte
        dataSize,
        false // big-endian
    );
    
    // Remaining bytes: source file data
    for (let i = 0; i < dataSize; i++) {
        writePixelByte(4 + i, srcBytes[i]);
    }
    
    // Build PNG
    const png = buildPNG(width, height, rawStream);
    download(png, file.name + '.png', 'image/png');
}

// ── Decode: .png → .blend ───────────────────────────────────────────────────

document.getElementById('button-2').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,image/png';
    input.onchange = e => decodeFile(e.target.files[0]);
    input.click();
});

async function decodeFile(file) {
    const raw  = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(raw.buffer);
    
    const idatChunks = [];
    let offset = 8;
    while (offset < raw.length) {
        const chunkLen  = view.getUint32(offset, false);
        const chunkType = String.fromCharCode(...raw.slice(offset + 4, offset + 8));
        if (chunkType === 'IDAT')
            idatChunks.push(raw.slice(offset + 8, offset + 8 + chunkLen));
        offset += 4 + 4 + chunkLen + 4;
    }
    if (!idatChunks.length) throw new Error('No IDAT chunk found');
    
    const idatData = concatBytes(idatChunks);
    
    const rawStream = await zlibDecompress(idatData);
    const width     = view.getInt32(16, false);
    const height    = view.getInt32(20, false);
    const bpp       = 4; // bytes per pixel (RGBA)
    const rowSize   = 1 + width * bpp;
    
    // Reconstruct all rows by undoing PNG filters
    // Result: a flat array of raw pixel bytes, filter bytes removed
    const pixels = new Uint8Array(width * bpp * height);
    
    for (let row = 0; row < height; row++) {
        const filterType = rawStream[row * rowSize];
        const rowStart   = row * rowSize + 1;         // skip filter byte
        const pixStart   = row * width * bpp;         // destination in pixels[]
        
        for (let col = 0; col < width * bpp; col++) {
            const x    = rawStream[rowStart + col];                         // raw byte
            const a    = col >= bpp ? pixels[pixStart + col - bpp] : 0;    // left pixel, same channel
            const b    = row > 0   ? pixels[pixStart - width * bpp + col] : 0; // pixel above
            const c    = (row > 0 && col >= bpp) ? pixels[pixStart - width * bpp + col - bpp] : 0; // above-left
            
            let recon;
            switch (filterType) {
                case 0: recon = x; break;                                     // None
                case 1: recon = x + a; break;                                 // Sub
                case 2: recon = x + b; break;                                 // Up
                case 3: recon = x + Math.floor((a + b) / 2); break;          // Average
                case 4: recon = x + paethPredictor(a, b, c); break;          // Paeth
                default: throw new Error(`Unknown filter type ${filterType}`);
            }
            pixels[pixStart + col] = recon & 0xFF;
        }
    }
    
    // Now pixels[] is a flat array of raw RGBA bytes — same layout as what we encoded
    // First 4 bytes = stored data size
    const rsView   = new DataView(pixels.buffer);
    const dataSize = rsView.getUint32(0, false);
    
    const out = new Uint8Array(dataSize);
    for (let i = 0; i < dataSize; i++) {
        out[i] = pixels[4 + i];
    }
    
    const baseName = file.name.replace(/\.png$/i, '');
    download(out.buffer, baseName + '.blend', 'application/octet-stream');
}
// ── PNG builder ───────────────────────────────────────────────────────────────

function buildPNG(width, height, rawStream) {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    
    const ihdr = buildChunk('IHDR', (() => {
        const b = new Uint8Array(13);
        const v = new DataView(b.buffer);
        v.setUint32(0, width,  false);
        v.setUint32(4, height, false);
        b[8]  = 8;  // bit depth (8 bits per channel)
        b[9]  = 6;  // colour type 6 = RGBA
        b[10] = 0;  // compression method
        b[11] = 0;  // filter method
        b[12] = 0;  // interlace method
        return b;
    })());
    
    const idat = buildChunk('IDAT', zlibCompress(rawStream));
    const iend = buildChunk('IEND', new Uint8Array(0));
    
    return concatBytes([signature, ihdr, idat, iend]);
}

function buildChunk(type, data) {
    const buf  = new Uint8Array(4 + 4 + data.length + 4);
    const view = new DataView(buf.buffer);
    
    view.setUint32(0, data.length, false);                    // length
    for (let i = 0; i < 4; i++)
        buf[4 + i] = type.charCodeAt(i);                        // type
    buf.set(data, 8);                                         // data
    view.setUint32(8 + data.length, crc32(buf.slice(4, 8 + data.length)), false); // CRC
    
    return buf;
}

// ── Zlib store mode ───────────────────────────────────────────────────────────

function zlibCompress(data) {
    // Zlib header: CMF=0x78 (deflate, window size 32K), FLG=0x01 (no dict, check bits)
    // 0x7801 is divisible by 31 as required
    const maxBlockSize = 65535;
    const numBlocks    = Math.ceil(data.length / maxBlockSize) || 1;
    
    // 2 (zlib header) + numBlocks * (5 block header + up to 65535 data) + 4 (adler32)
    const out  = new Uint8Array(2 + numBlocks * 5 + data.length + 4);
    const view = new DataView(out.buffer);
    let off = 0;
    
    out[off++] = 0x78;  // CMF
    out[off++] = 0x01;  // FLG
    
    for (let i = 0; i < numBlocks; i++) {
        const start   = i * maxBlockSize;
        const end     = Math.min(start + maxBlockSize, data.length);
        const blkSize = end - start;
        const isLast  = i === numBlocks - 1 ? 1 : 0;
        
        out[off++] = isLast;                        // BFINAL + BTYPE=00 (store)
        view.setUint16(off, blkSize,        true);  // LEN  (little-endian)
        view.setUint16(off + 2, ~blkSize & 0xFFFF, true); // NLEN (one's complement)
        off += 4;
        
        out.set(data.slice(start, end), off);
        off += blkSize;
    }
    
    // Adler-32 checksum (big-endian)
    view.setUint32(off, adler32(data), false);
    return out.slice(0, off + 4);
}

async function zlibDecompress(data) {
    const ds     = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    
    // Write and close in the background — don't await before reading
    const writePromise = writer.write(data).then(() => writer.close());
    
    const chunks = [];
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    
    await writePromise; // ensure write completed without errors
    return concatBytes(chunks);
}

// ── CRC-32 ────────────────────────────────────────────────────────────────────

const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++)
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Adler-32 ─────────────────────────────────────────────────────────────────

function adler32(data) {
    let s1 = 1, s2 = 0;
    for (const byte of data) {
        s1 = (s1 + byte)      % 65521;
        s2 = (s2 + s1)        % 65521;
    }
    return ((s2 << 16) | s1) >>> 0;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function concatBytes(arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out   = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
}

function download(buffer, filename, mime) {
    const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function paethPredictor(a, b, c) {
    const p  = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}