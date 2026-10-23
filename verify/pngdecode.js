// Dev-only PNG decoder (8-bit RGB/RGBA/gray, non-interlaced) for verification.
// Uses node:zlib for inflate so it is independent of render/src/png.js's encoders.
import { inflateSync, crc32 } from 'node:zlib';

export function decodePng(buf) {
  const b = Buffer.from(buf);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, w, h, bitDepth, colorType, interlace;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8);
    const data = b.subarray(o + 8, o + 8 + len);
    const crc = b.readUInt32BE(o + 8 + len);
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== crc) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG: depth ${bitDepth} interlace ${interlace}`);
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0;
      const up = y ? px[(y - 1) * stride + i] : 0;
      const c = y && i >= bpp ? px[(y - 1) * stride + i - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[y * stride + i] = (src[i] + pred) & 255;
    }
  }
  return { width: w, height: h, bpp, px, raw };
}

/** Coverage of black-on-white from the red channel. */
export const coverageFromPng = ({ width, height, bpp, px }) =>
  Float32Array.from({ length: width * height }, (_, i) => 1 - px[i * bpp] / 255);

/** Expand gray / gray+alpha / RGB / RGBA pixels to RGBA, so images compare across PNG color types. */
export function toRgba({ width, height, bpp, px }) {
  if (bpp === 4) return px;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp, o = i * 4;
    if (bpp === 1) { out[o] = out[o + 1] = out[o + 2] = px[s]; out[o + 3] = 255; }
    else if (bpp === 2) { out[o] = out[o + 1] = out[o + 2] = px[s]; out[o + 3] = px[s + 1]; }
    else { out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = 255; }
  }
  return out;
}
