// @ts-check
// RGBA -> PNG bytes. Two zlib encoders behind one port:
//   storedZlib   pure JS, RFC 1950/1951 stored blocks: no compression, trivially correct
//   nativeZlib   CompressionStream('deflate'): real compression, platform code
// Row filtering (PNG §9) is pure JS and shared: per-row minimum-sum-of-absolute-
// differences heuristic, the one libpng and the spec recommend.

import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { deflater, Lz, Entropy } from './deflate.js';

/**
 * Incremental zlib: `push` returns the compressed bytes that are final so far (possibly
 * none); `finish` returns the rest, trailer included. Concatenated, they are one zlib stream.
 * Contract: `push` must not retain `raw` after it returns (copy what you keep), so callers can
 * reuse one row buffer for every band. Every implementation here copies.
 * @typedef {{ push: (raw: Uint8Array) => Promise<Uint8Array>, finish: () => Promise<Uint8Array> }} ZlibStream
 */
/**
 * @typedef {object} Zlib
 * @property {string} name
 * @property {(raw: Uint8Array, span?: import('../../otel-compact/src/trace.js').Span) => Promise<Uint8Array>} deflate
 * @property {() => ZlibStream} stream
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309), as PNG chunks use. @param {Uint8Array} b @param {number} [crc] */
export function crc32(b, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Adler-32 (RFC 1950); pass the previous value to continue a running checksum. @param {Uint8Array} b @param {number} [prev] */
export function adler32(b, prev = 1) {
  let a = prev & 0xffff, s = prev >>> 16;
  for (let i = 0; i < b.length;) {
    const end = Math.min(b.length, i + 5552); // largest n with no u32 overflow before the modulo
    for (; i < end; i++) { a += b[i]; s += a; }
    a %= 65521; s %= 65521;
  }
  return ((s << 16) | a) >>> 0;
}

/** @type {Zlib} */
export const storedZlib = Object.freeze({
  name: 'stored',
  async deflate(raw, span = NOOP_SPAN) {
    return span.span('deflate.stored', { atomic: true, items: raw.length }, () => storedSync(raw));
  },
  stream: () => storedStream(),
});

/**
 * Stored blocks, streamed. A full block is held back until more input proves it is not
 * the last, so BFINAL lands where storedSync puts it: the output is byte-identical.
 * @returns {ZlibStream}
 */
function storedStream() {
  /** @type {Uint8Array[]} */
  let pend = [];
  let pendLen = 0, ad = 1, started = false;
  const take = (/** @type {number} */ n) => {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const head = pend[0], k = Math.min(head.length, n - o);
      out.set(head.subarray(0, k), o); o += k;
      if (k === head.length) pend.shift(); else pend[0] = head.subarray(k);
    }
    pendLen -= n;
    return out;
  };
  /** @param {Uint8Array} body @param {number} final */
  const block = (body, final) => {
    const out = new Uint8Array(5 + body.length), len = body.length;
    out[0] = final; out[1] = len & 255; out[2] = len >> 8; out[3] = ~len & 255; out[4] = (~len >> 8) & 255;
    out.set(body, 5);
    return out;
  };
  const header = () => (started ? [] : ((started = true), [new Uint8Array([0x78, 0x01])]));
  return {
    async push(raw) {
      ad = adler32(raw, ad);
      if (raw.length) { pend.push(raw.slice()); pendLen += raw.length; }
      const parts = header();
      while (pendLen > 65535) parts.push(block(take(65535), 0));
      return concat(parts);
    },
    async finish() {
      const parts = header();
      do parts.push(block(take(Math.min(65535, pendLen)), pendLen <= 65535 ? 1 : 0)); while (pendLen > 0);
      parts.push(new Uint8Array([ad >>> 24, (ad >>> 16) & 255, (ad >>> 8) & 255, ad & 255]));
      return concat(parts);
    },
  };
}

/** @param {Uint8Array[]} parts */
function concat(parts) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** @param {Uint8Array} raw */
function storedSync(raw) {
  {
    const blocks = Math.max(1, Math.ceil(raw.length / 65535));
    const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
    out[0] = 0x78; out[1] = 0x01; // CM=8, CINFO=7; FLEVEL=0; FCHECK makes 0x7801 % 31 == 0
    let o = 2;
    for (let b = 0; b < blocks; b++) {
      const start = b * 65535, len = Math.min(65535, raw.length - start);
      out[o++] = b === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00
      out[o++] = len & 255; out[o++] = len >> 8;
      out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255;
      out.set(raw.subarray(start, start + len), o);
      o += len;
    }
    const ad = adler32(raw);
    out[o++] = ad >>> 24; out[o++] = (ad >>> 16) & 255; out[o++] = (ad >>> 8) & 255; out[o++] = ad & 255;
    return out;
  }
}

/** @type {Zlib} */
export const nativeZlib = Object.freeze({
  name: 'native',
  async deflate(raw, span = NOOP_SPAN) {
    const s = span.span('deflate.native.pipe', { atomic: true }, () =>
      new Blob([/** @type {BlobPart} */ (raw)]).stream().pipeThrough(new CompressionStream('deflate')));
    return span.span('deflate.native.drain', { atomic: true, items: raw.length }, async () => new Uint8Array(await new Response(s).arrayBuffer()));
  },
  stream() {
    const cs = new CompressionStream('deflate');
    const w = cs.writable.getWriter(), r = cs.readable.getReader();
    /** @type {Uint8Array[]} */
    let got = [];
    // Drain concurrently, or writes stall once the readable side's queue fills.
    const drained = (async () => { for (;;) { const { done, value } = await r.read(); if (done) return; got.push(value); } })();
    const take = () => { const out = concat(got.length ? got : [new Uint8Array(0)]); got = []; return out; };
    return {
      async push(raw) { await w.write(raw.slice()); return take(); },
      async finish() { await w.close(); await drained; return take(); },
    };
  },
});


/**
 * Filter scanlines: each row gets the filter type (0-4) minimising Σ|signed byte|.
 * @param {Uint8Array} px  w·h·bpp bytes
 * @param {number} w @param {number} h @param {number} bpp
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 */
export function filterRows(px, w, h, bpp, span = NOOP_SPAN) {
  const stride = w * bpp;
  const { out, cand, zero } = span.span('png.filter.alloc', { atomic: true, items: h * (stride + 1) }, () =>
    ({ out: new Uint8Array(h * (stride + 1)), cand: Array.from({ length: 5 }, () => new Uint8Array(stride)), zero: new Uint8Array(stride) }));
  const [c0, c1, c2, c3, c4] = cand;
  // 32-bit view for the row-equality shortcut (needs 4-byte alignment and whole words per row).
  const words = px.byteOffset % 4 === 0 && stride % 4 === 0 ? new Uint32Array(px.buffer, px.byteOffset, (h * stride) >> 2) : null;
  // Single pass: all five candidates and their Σ|signed byte| scores together.
  // (A score-only pass followed by writing the winner measured 1.75× slower: the
  // second pass re-reads the row and re-branches on the filter per byte.)
  for (let y0 = 0; y0 < h; y0 += ROWS) span.span('png.filter.rows', { atomic: true, items: Math.min(ROWS, h - y0), y: y0 }, () => {
    for (let y = y0; y < Math.min(h, y0 + ROWS); y++) {
      // Shortcut, exact: a row equal to the one above scores 0 under Up, the
      // minimum. None and Sub tie at 0 only for an all-zero row, and win the tie
      // by order; so the choice is 0 (all zero) or 2, and the filtered bytes are zero.
      if (words && sameAsAbove(words, y, stride >> 2)) {
        const z = allZero(words, y, stride >> 2);
        out[y * (stride + 1)] = z ? 0 : 2; // filtered bytes are zero either way; `out` is fresh
        continue;
      }
      const row = px.subarray(y * stride, (y + 1) * stride);
      const up = y ? px.subarray((y - 1) * stride, y * stride) : zero;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
      for (let i = 0; i < bpp; i++) { // no left neighbour: a = c = 0, paeth(0, b, 0) = b
        const x = row[i], b = up[i];
        const v0 = x, v1 = x, v2 = (x - b) & 255, v3 = (x - (b >> 1)) & 255, v4 = (x - b) & 255;
        c0[i] = v0; c1[i] = v1; c2[i] = v2; c3[i] = v3; c4[i] = v4;
        s0 += COST[v0]; s1 += COST[v1]; s2 += COST[v2]; s3 += COST[v3]; s4 += COST[v4];
      }
      for (let i = bpp; i < stride; i++) {
        const x = row[i], a = row[i - bpp], b = up[i], c = up[i - bpp];
        const p = a + b - c;
        const pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        const v0 = x, v1 = (x - a) & 255, v2 = (x - b) & 255, v3 = (x - ((a + b) >> 1)) & 255, v4 = (x - pr) & 255;
        c0[i] = v0; c1[i] = v1; c2[i] = v2; c3[i] = v3; c4[i] = v4;
        s0 += COST[v0]; s1 += COST[v1]; s2 += COST[v2]; s3 += COST[v3]; s4 += COST[v4];
      }
      let best = 0, bestSum = s0; // first minimum wins: ties go to the lower filter type
      if (s1 < bestSum) { bestSum = s1; best = 1; }
      if (s2 < bestSum) { bestSum = s2; best = 2; }
      if (s3 < bestSum) { bestSum = s3; best = 3; }
      if (s4 < bestSum) best = 4;
      out[y * (stride + 1)] = best;
      out.set(cand[best], y * (stride + 1) + 1);
    }
  });
  return out;
}
/** Row y equals row y-1 (row -1 is all zeros). @param {Uint32Array} w @param {number} y @param {number} n words per row */
function sameAsAbove(w, y, n) {
  const r = y * n;
  if (y === 0) { for (let i = 0; i < n; i++) if (w[i] !== 0) return false; return true; }
  for (let i = 0; i < n; i++) if (w[r + i] !== w[r - n + i]) return false;
  return true;
}
/** @param {Uint32Array} w @param {number} y @param {number} n */
function allZero(w, y, n) {
  const r = y * n;
  for (let i = 0; i < n; i++) if (w[r + i] !== 0) return false;
  return true;
}

/** |signed byte| for the filter heuristic. */
const COST = Uint8Array.from({ length: 256 }, (_, v) => (v < 128 ? v : 256 - v));
const ROWS = 8;

/** @param {string} type @param {Uint8Array} data */
export function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * No filtering: each row is its filter byte (0) and the raw bytes.
 * Measured on rendered text (6 images, both fonts, 24-96 px): smallest output of
 * all strategies with both zlibs (fast −6%, native −12% vs adaptive), and nearly
 * free. Anti-aliased text on a flat background is long raw repeats; per-row
 * filters break them up. Use `adaptive` for photographic content.
 * @param {Uint8Array} px @param {number} w @param {number} h @param {number} bpp
 * @param {Uint8Array} [into]  reused output (filter bytes must be 0); a fresh one if too small
 */
export function unfilteredRows(px, w, h, bpp, into) {
  const stride = w * bpp;
  const need = h * (stride + 1);
  const out = into && into.length >= need ? into.subarray(0, need) : new Uint8Array(need);
  for (let y = 0; y < h; y++) out.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return out;
}

/** @typedef {'none' | 'adaptive'} PngFilter */

/** PNG color type per channel count: gray, RGB, RGBA. */
export const COLOR_TYPE = /** @type {Record<number, number>} */ ({ 1: 0, 3: 2, 4: 6 });

/**
 * @param {{ width: number, height: number, channels?: 1 | 3 | 4, data?: Uint8Array, rgba?: Uint8Array }} img
 *   pixels as `data` with `channels` (1 gray, 3 RGB, 4 RGBA), or legacy `rgba`
 * @param {Zlib} zlib
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @param {{ filter?: PngFilter }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function encodePng(img, zlib, span = NOOP_SPAN, { filter = 'none' } = {}) {
  const { width, height } = img;
  const bpp = img.data ? (img.channels ?? 4) : 4;
  const px = /** @type {Uint8Array} */ (img.data ?? img.rgba);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr.set([8, COLOR_TYPE[bpp], 0, 0, 0], 8); // 8-bit, gray|RGB|RGBA, deflate, adaptive filtering, no interlace
  const filtered = span.span('png.filter', { rows: height, filter, bpp }, (fs) =>
    (filter === 'adaptive' ? filterRows(px, width, height, bpp, fs) : fs.span('png.filter.none', { atomic: true, items: height }, () => unfilteredRows(px, width, height, bpp))));
  const idat = await span.span('png.deflate', { zlib: zlib.name, in: filtered.length }, async (ds) => {
    const z = await zlib.deflate(filtered, ds);
    ds.set('out', z.length);
    return z;
  });
  return span.span('png.chunks', { atomic: true, items: idat.length }, () => {
    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  });
}

// --- fast pure-JS deflate ------------------------------------------------------
// RFC 1951 fixed-Huffman block, greedy LZ77: one hash probe per position plus a
// distance-1 run check (filtered PNG rows are mostly zeros and short repeats).

/** Bit-reverse the low `n` bits of `c`. @param {number} c @param {number} n */
const rev = (c, n) => { let r = 0; for (let i = 0; i < n; i++) { r = (r << 1) | (c & 1); c >>= 1; } return r; };
// Fixed literal/length code (RFC 1951 §3.2.6), pre-reversed for an LSB-first writer.
const LIT_CODE = new Uint16Array(288), LIT_LEN = new Uint8Array(288);
for (let s = 0; s < 288; s++) {
  const [base, len, first] = s < 144 ? [0x30, 8, 0] : s < 256 ? [0x190, 9, 144] : s < 280 ? [0, 7, 256] : [0xc0, 8, 280];
  LIT_CODE[s] = rev(base + s - first, len); LIT_LEN[s] = len;
}
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// length 3..258 -> code index; distance -> code index via two tables (as zlib's _dist_code).
const LEN_IDX = new Uint8Array(259);
for (let i = 0; i < 29; i++) for (let l = LEN_BASE[i]; l < (i < 28 ? LEN_BASE[i + 1] : 259); l++) LEN_IDX[l] = i;
const DIST_LO = new Uint8Array(257), DIST_HI = new Uint8Array(256);
for (let i = 0; i < 30; i++) {
  const end = i < 29 ? DIST_BASE[i + 1] : 32769;
  for (let d = DIST_BASE[i]; d < end; d++) { if (d <= 256) DIST_LO[d] = i; else DIST_HI[(d - 1) >> 7] = i; }
}
const DIST_CODE = Uint8Array.from({ length: 30 }, (_, i) => rev(i, 5));

/** @param {Uint8Array} src */
function fastDeflateSync(src) {
  const n = src.length;
  let out = new Uint8Array(Math.max(64, (n >> 3) + 64));
  let o = 2, bits = 0, nb = 0;
  out[0] = 0x78; out[1] = 0x01;
  /** @param {number} v @param {number} k */
  const put = (v, k) => {
    bits |= v << nb; nb += k;
    while (nb >= 8) {
      if (o >= out.length) { const g = new Uint8Array(out.length * 2); g.set(out); out = g; }
      out[o++] = bits & 255; bits >>>= 8; nb -= 8;
    }
  };
  put(1, 1); put(1, 2); // BFINAL=1, BTYPE=01 (fixed Huffman)
  const HB = 15, head = new Int32Array(1 << HB).fill(-1);
  const hash = (/** @type {number} */ p) => Math.imul((src[p] << 16) | (src[p + 1] << 8) | src[p + 2], 0x9e3779b1) >>> (32 - HB);
  let p = 0;
  while (p < n) {
    let bestLen = 0, bestDist = 0;
    if (p + 3 <= n) {
      const max = Math.min(258, n - p);
      if (p > 0 && src[p - 1] === src[p] && src[p] === src[p + 1] && src[p] === src[p + 2]) {
        let l = 3; const b = src[p]; while (l < max && src[p + l] === b) l++;
        bestLen = l; bestDist = 1;
      }
      const h = hash(p), cand = head[h];
      head[h] = p;
      if (bestLen < max && cand >= 0 && p - cand <= 32768 && p - cand > 1) {
        let l = 0; while (l < max && src[cand + l] === src[p + l]) l++;
        if (l >= 3 && l > bestLen) { bestLen = l; bestDist = p - cand; }
      }
    }
    if (bestLen >= 3) {
      const li = LEN_IDX[bestLen];
      put(LIT_CODE[257 + li], LIT_LEN[257 + li]);
      if (LEN_EXTRA[li]) put(bestLen - LEN_BASE[li], LEN_EXTRA[li]);
      const di = bestDist <= 256 ? DIST_LO[bestDist] : DIST_HI[(bestDist - 1) >> 7];
      put(DIST_CODE[di], 5);
      if (DIST_EXTRA[di]) put(bestDist - DIST_BASE[di], DIST_EXTRA[di]);
      p += bestLen;
    } else {
      put(LIT_CODE[src[p]], LIT_LEN[src[p]]);
      p++;
    }
  }
  put(LIT_CODE[256], LIT_LEN[256]); // end of block
  if (nb > 0) put(0, 8 - nb);
  const ad = adler32(src);
  if (o + 4 > out.length) { const g = new Uint8Array(o + 4); g.set(out); out = g; }
  out[o++] = ad >>> 24; out[o++] = (ad >>> 16) & 255; out[o++] = (ad >>> 8) & 255; out[o++] = ad & 255;
  return out.subarray(0, o);
}

/**
 * fastDeflateSync, incrementally. Greedy LZ77 at position p reads at most p+258 ahead
 * (and p−32768 behind), so positions are only encoded while 258 bytes of lookahead are
 * buffered; `finish` encodes the tail. Every match decision sees the same bytes as the
 * whole-buffer encoder, so the concatenated output is byte-identical to it.
 * @returns {ZlibStream}
 */
function fastStream() {
  const WIN = 32768, LOOK = 258;
  let buf = new Uint8Array(1 << 16), base = 0, len = 0, p = 0; // absolute positions; buf[i] holds byte base+i
  let out = new Uint8Array(1 << 12), o = 0, bits = 0, nb = 0, ad = 1;
  /** @param {number} v @param {number} k */
  const put = (v, k) => {
    bits |= v << nb; nb += k;
    while (nb >= 8) {
      if (o >= out.length) { const g = new Uint8Array(out.length * 2); g.set(out); out = g; }
      out[o++] = bits & 255; bits >>>= 8; nb -= 8;
    }
  };
  out[0] = 0x78; out[1] = 0x01; o = 2;
  put(1, 1); put(1, 2); // BFINAL=1, BTYPE=01 (fixed Huffman)
  const HB = 15, head = new Int32Array(1 << HB).fill(-1);
  /** @param {boolean} final */
  const encode = (final) => {
    const src = buf, b = base, n = len, stop = final ? n : n - LOOK;
    const hash = (/** @type {number} */ q) => Math.imul((src[q - b] << 16) | (src[q - b + 1] << 8) | src[q - b + 2], 0x9e3779b1) >>> (32 - HB);
    while (p < stop) {
      let bestLen = 0, bestDist = 0;
      const i = p - b;
      if (p + 3 <= n) {
        const max = Math.min(258, n - p);
        if (p > 0 && src[i - 1] === src[i] && src[i] === src[i + 1] && src[i] === src[i + 2]) {
          let l = 3; const c = src[i]; while (l < max && src[i + l] === c) l++;
          bestLen = l; bestDist = 1;
        }
        const h = hash(p), cand = head[h];
        head[h] = p;
        if (bestLen < max && cand >= 0 && p - cand <= 32768 && p - cand > 1) {
          const j = cand - b;
          let l = 0; while (l < max && src[j + l] === src[i + l]) l++;
          if (l >= 3 && l > bestLen) { bestLen = l; bestDist = p - cand; }
        }
      }
      if (bestLen >= 3) {
        const li = LEN_IDX[bestLen];
        put(LIT_CODE[257 + li], LIT_LEN[257 + li]);
        if (LEN_EXTRA[li]) put(bestLen - LEN_BASE[li], LEN_EXTRA[li]);
        const di = bestDist <= 256 ? DIST_LO[bestDist] : DIST_HI[(bestDist - 1) >> 7];
        put(DIST_CODE[di], 5);
        if (DIST_EXTRA[di]) put(bestDist - DIST_BASE[di], DIST_EXTRA[di]);
        p += bestLen;
      } else {
        put(LIT_CODE[src[i]], LIT_LEN[src[i]]);
        p++;
      }
    }
  };
  const drain = () => { const r = out.slice(0, o); o = 0; return r; };
  return {
    async push(raw) {
      ad = adler32(raw, ad);
      // Keep the 32 KiB window behind p (plus one byte for the run check); drop the rest.
      const keep = Math.max(base, p - WIN - 1);
      if (len + raw.length - keep > buf.length) {
        const g = new Uint8Array(Math.max(buf.length, 2 * (len + raw.length - keep)));
        g.set(buf.subarray(keep - base, len - base)); buf = g; base = keep;
      } else if (len + raw.length - base > buf.length) {
        buf.copyWithin(0, keep - base, len - base); base = keep;
      }
      buf.set(raw, len - base); len += raw.length;
      encode(false);
      return drain();
    },
    async finish() {
      encode(true);
      put(LIT_CODE[256], LIT_LEN[256]); // end of block
      if (nb > 0) put(0, 8 - nb);
      const t = drain(), r = new Uint8Array(t.length + 4);
      r.set(t); r.set([ad >>> 24, (ad >>> 16) & 255, (ad >>> 8) & 255, ad & 255], t.length);
      return r;
    },
  };
}

/** @type {Zlib} */
export const fastZlib = Object.freeze({
  name: 'fast',
  async deflate(raw, span = NOOP_SPAN) {
    return span.span('deflate.fast', { atomic: true, items: raw.length }, () => fastDeflateSync(raw));
  },
  stream: () => fastStream(),
});

/**
 * A Zlib from any match finder × entropy coder. Whole-buffer `deflate` is one push plus
 * finish of the same streaming core, so the two are byte-identical by construction.
 * @param {{ name: string, lz: import('./deflate.js').LzT, entropy: import('./deflate.js').EntropyT, blockBytes?: number }} cfg
 * @returns {Zlib}
 */
export function zlibOf({ name, lz, entropy, blockBytes }) {
  return Object.freeze({
    name,
    async deflate(raw, span = NOOP_SPAN) {
      return span.span(`deflate.${name}`, { atomic: true, items: raw.length }, () => {
        const d = deflater({ lz, entropy, blockBytes }, adler32);
        const a = d.push(raw), b = d.finish();
        return concat([a, b]);
      });
    },
    stream() {
      const d = deflater({ lz, entropy, blockBytes }, adler32);
      return { push: async (raw) => d.push(raw), finish: async () => d.finish() };
    },
  });
}

/** The pluggable core configured as the original `fast`: must reproduce fastDeflateSync byte for byte. */
export const greedyFixedZlib = zlibOf({ name: 'greedy-fixed', lz: Lz.Greedy, entropy: Entropy.Fixed });
/** The measured knee (bench/deflate.js): −42% bytes vs fast for ~1.8× its time. */
// blockBytes 64 KiB: +0.35% bytes for 8× more IDATs, so a streamed PNG paints in small steps (bench: posters @1x).
export const balancedZlib = zlibOf({ name: 'balanced', lz: Lz.Chain(16, 16, 64, 8, 8), entropy: Entropy.Dynamic, blockBytes: 1 << 16 });
/** Every position hashed: zlib -6 sizes, ~3.5× fast's time. */
export const maxZlib = zlibOf({ name: 'max', lz: Lz.Chain(16, 16, 64, 8, 258), entropy: Entropy.Dynamic, blockBytes: 1 << 16 });
