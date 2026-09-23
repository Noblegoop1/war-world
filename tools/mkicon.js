// Turn a dark-on-light icon PNG into a white-on-transparent one the game can tint.
// Decodes the PNG by hand (zlib + unfilter), keys the shape out by luminance, trims the margin and
// re-encodes. No image libraries in this project, and these are the only two raster icons we ship.
const fs = require('fs');
const zlib = require('zlib');

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; color = data[9];
      if (depth !== 8) throw new Error('only 8-bit supported, got ' + depth);
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error('unsupported colour type ' + color);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// SOLID below this luminance, gone above KEEP_MAX. The gap keeps the anti-aliased edge smooth while
// throwing away pale things like the stock-site watermark on the airship.
const INK_MAX = 110;
const KEEP_MAX = 185;

function convert(src, dst, pad = 6) {
  const img = decodePng(src);
  const { width, height, channels, data } = img;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    let r, g, b, a = 255;
    if (channels === 1) { r = g = b = data[o]; }
    else if (channels === 2) { r = g = b = data[o]; a = data[o + 1]; }
    else if (channels === 3) { r = data[o]; g = data[o + 1]; b = data[o + 2]; }
    else { r = data[o]; g = data[o + 1]; b = data[o + 2]; a = data[o + 3]; }
    // composite over white first, so a transparent source background reads as background
    const f = a / 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) * f + 255 * (1 - f);
    let av = lum <= INK_MAX ? 1 : lum >= KEEP_MAX ? 0 : (KEEP_MAX - lum) / (KEEP_MAX - INK_MAX);
    alpha[i] = Math.round(av * 255);
  }
  // trim to what is actually drawn
  let minx = width, maxx = -1, miny = height, maxy = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (alpha[y * width + x] < 8) continue;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  minx = Math.max(0, minx - pad); miny = Math.max(0, miny - pad);
  maxx = Math.min(width - 1, maxx + pad); maxy = Math.min(height - 1, maxy + pad);
  const w = maxx - minx + 1, h = maxy - miny + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = alpha[(y + miny) * width + (x + minx)];
    const o = (y * w + x) * 4;
    out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = a;   // white shape, alpha carries it
  }
  fs.writeFileSync(dst, encodePng(w, h, out));
  const solid = alpha.reduce((n, v) => n + (v > 200 ? 1 : 0), 0);
  console.log(`${dst}: ${width}x${height} -> ${w}x${h}, ${solid} solid px (${(100 * solid / (width * height)).toFixed(1)}% of source)`);
}

const [, , src, dst] = process.argv;
convert(src, dst);
