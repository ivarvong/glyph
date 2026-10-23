// @ts-check
// Content-addressed keys: a render's key is the SHA-256 of everything that decides its bytes.
// Names are not identity (two fonts can both be called 'inter'), so path *content* is hashed:
// each path once, memoised by object identity, then referenced from the scene encoding.
// SHA-256 is pure JS (FIPS 180-4) so keys are synchronous and identical on every runtime;
// tests check it against node:crypto and crypto.subtle.
import { isSolid, paintKey } from '../../render/src/paint.js';
import { isDeferred } from '../../render/src/scene.js';


const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of `msg`, as 32 bytes. @param {Uint8Array} msg @returns {Uint8Array} */
export function sha256(msg) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const n = msg.length, total = ((n + 9 + 63) >> 6) << 6;
  const tail = new Uint8Array(total - (n & ~63));
  tail.set(msg.subarray(n & ~63)); tail[n & 63] = 0x80;
  const bits = n * 8, tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32)); tv.setUint32(tail.length - 4, bits >>> 0);
  const w = new Uint32Array(64);
  /** @param {Uint8Array} b @param {number} o */
  const block = (b, o) => {
    for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  };
  for (let o = 0; o + 64 <= n; o += 64) block(msg, o);
  for (let o = 0; o < tail.length; o += 64) block(tail, o);
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, h[i]);
  return out;
}

export const hex = (/** @type {Uint8Array} */ b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Growable little writer for canonical encodings. */
class Writer {
  constructor() { this.buf = new Uint8Array(1024); this.dv = new DataView(this.buf.buffer); this.o = 0; }
  /** @param {number} n */
  room(n) {
    if (this.o + n <= this.buf.length) return;
    const g = new Uint8Array(Math.max(this.buf.length * 2, this.o + n)); g.set(this.buf); this.buf = g; this.dv = new DataView(g.buffer);
  }
  /** @param {number} v */ u8(v) { this.room(1); this.buf[this.o++] = v; }
  /** @param {number} v */ u32(v) { this.room(4); this.dv.setUint32(this.o, v); this.o += 4; }
  /** Exact: the float's own bits, so 0.1 + 0.2 and 0.3 are different keys, as they are different pixels. @param {number} v */
  f64(v) { this.room(8); this.dv.setFloat64(this.o, v); this.o += 8; }
  /** @param {Uint8Array} b */ bytes(b) { this.room(b.length); this.buf.set(b, this.o); this.o += b.length; }
  /** @param {string} s */ str(s) { const b = new TextEncoder().encode(s); this.u32(b.length); this.bytes(b); }
  done() { return this.buf.subarray(0, this.o); }
}

/** @type {WeakMap<object, Uint8Array>} */
const PATH_DIGEST = new WeakMap();
const SEG_TAG = /** @type {Record<string, number>} */ ({ MoveTo: 1, LineTo: 2, QuadTo: 3, CubicTo: 4, Close: 5 });
const SEG_FIELDS = /** @type {Record<string, string[]>} */ ({ MoveTo: ['x', 'y'], LineTo: ['x', 'y'], QuadTo: ['x1', 'y1', 'x', 'y'], CubicTo: ['x1', 'y1', 'x2', 'y2', 'x', 'y'], Close: [] });

/** Digest of one path's segments, memoised per path object. @param {import('../../outline/src/path.js').Path} path */
export function pathDigest(path) {
  const known = PATH_DIGEST.get(path);
  if (known) return known;
  let d;
  const w = new Writer();
  for (const s of path) {
    w.u8(SEG_TAG[s.tag]);
    for (const f of SEG_FIELDS[s.tag]) w.f64(/** @type {any} */ (s)[f]);
  }
  d = sha256(w.done());
  PATH_DIGEST.set(path, d);
  return d;
}

/**
 * Key for a rendered scene: version, render configuration, canvas, and every item's path
 * content, exact transform and fill, in order (order is paint order). Stable across runtimes.
 * @param {import('../../render/src/scene.js').Scene} scene
 * @param {Record<string, string | number | boolean>} config  e.g. { format: 'png', rasterizer: 'scanline', zlib: 'balanced' }
 * @param {string} [version]  bump when output bytes change for the same inputs
 */
export function sceneKey(scene, config, version = 'glyph/1') {
  const w = new Writer();
  w.str(version);
  for (const k of Object.keys(config).sort()) { w.str(k); w.str(String(config[k])); }
  w.u32(scene.width); w.u32(scene.height); w.bytes(Uint8Array.from(scene.background));
  /** @type {Map<object, number>} */
  const ref = new Map();
  w.u32(scene.items.length);
  for (const it of scene.items) {
    // Tags 0/1 (new path / back-reference): a solid fill, nonzero rule: the original encoding,
    // so existing keys are unchanged. Tags 2/3: any other paint or rule, written as strings.
    const plain = isSolid(it.fill) && it.rule !== 'evenodd', ext = plain ? 0 : 2;
    // Tag 4: deferred geometry, named by its own description (it is never built for a key).
    if (isDeferred(it.path)) { w.u8(4 + ext); w.str(it.path.describe()); }
    else if (ref.has(it.path)) { w.u8(1 + ext); w.u32(/** @type {number} */ (ref.get(it.path))); }
    else { ref.set(it.path, ref.size); w.u8(ext); w.bytes(pathDigest(it.path)); }
    for (const v of it.transform) w.f64(v);
    if (isSolid(it.fill) && plain) w.bytes(Uint8Array.from(it.fill));
    else { w.str(it.rule === 'evenodd' ? 'evenodd' : 'nonzero'); w.str(paintKey(it.fill)); }
  }
  return hex(sha256(w.done()));
}
