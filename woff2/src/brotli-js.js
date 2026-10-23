// @ts-check
// Brotli decoder (RFC 7932) in plain JS. One pure function:
//   brotliDecode(bytes, { sizeHint? }) -> Result<Uint8Array, BrotliError>
// Internals use local mutable state (bit reader, output buffer). Errors are values: the
// first malformation is recorded in the reader (a sticky fault, like a C decoder's result
// code; later faults never replace it), a read past the end returns 0, and every loop checks
// `br.bad`, so a bad stream ends promptly with Err. No exceptions, on any input.
//
// Section numbers refer to RFC 7932. Constant tables either restate the RFC
// or are generated from google/brotli (./brotli-data.js).

import { variants, ok, err, some, NONE } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { DICTIONARY_BASE64, NDBITS, DICT_OFFSETS, TRANSFORMS, CONTEXT_LOOKUP } from './brotli-data.js';

export const BrotliError = variants('BrotliError', {
  Truncated: ['at'],
  Invalid: ['what', 'at'],
  TrailingBits: [],
});


// --- static data -----------------------------------------------------------

/** @type {Uint8Array | null} */
let dictionary = null;
const dict = () => {
  if (dictionary) return dictionary;
  const bin = atob(DICTIONARY_BASE64);
  const d = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) d[i] = bin.charCodeAt(i);
  return (dictionary = d);
};

const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
// Fixed code for code-length code lengths (§3.5), indexed by the next 4 bits.
const CL_LEN = [2, 2, 2, 3, 2, 2, 2, 4, 2, 2, 2, 3, 2, 2, 2, 4];
const CL_VAL = [0, 4, 3, 2, 0, 4, 3, 1, 0, 4, 3, 2, 0, 4, 3, 5];

// §6: block length codes.
const BLEN_BASE = [1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433, 16625];
const BLEN_EXTRA = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24];
// §5: insert and copy length codes.
const INS_BASE = [0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26, 34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210, 22594];
const INS_EXTRA = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24];
const COPY_BASE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094, 2118];
const COPY_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24];
const CMD_INS_OFF = [0, 0, 0, 0, 8, 8, 0, 16, 8, 16, 16];
const CMD_COPY_OFF = [0, 8, 0, 8, 0, 8, 16, 0, 16, 8, 16];
// §4: distance short codes 0-15 -> (ring index, delta).
const DIST_RING = [0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
const DIST_DELTA = [0, 0, 0, 0, -1, 1, -2, 2, -3, 3, -1, 1, -2, 2, -3, 3];

// --- bit reader ------------------------------------------------------------

/** @param {Uint8Array} src */
function bitReader(src) {
  let pos = 0, buf = 0, n = 0; // n ≤ 31 valid bits in buf, LSB = next bit
  /** @type {import('../../otel-compact/src/adt.js').Option<any>} */
  let fault = NONE;
  let bad = false; // mirrors fault.tag === 'Some', as a plain boolean for the hot path
  /** Record the first fault; returns 0 so callers can `return br.fail(…)`. @param {any} e */
  const fail = (e) => { if (!bad) { fault = some(e); bad = true; } return 0; };
  /** Top up to ≥ k bits if input remains (k ≤ 24). */
  const top = (/** @type {number} */ k) => {
    while (n < k && pos < src.length) { buf = (buf | (src[pos++] << n)) >>> 0; n += 8; }
  };
  return {
    fail,
    get bad() { return bad; },
    get fault() { return fault.tag === 'Some' ? fault.value : null; },
    /** Read k ≤ 24 bits, LSB first; Truncated (and 0) if the input ends. */
    bits(/** @type {number} */ k) {
      if (k === 0) return 0;
      top(k);
      if (n < k) return fail(BrotliError.Truncated(pos));
      const v = buf & ((1 << k) - 1);
      buf >>>= k; n -= k;
      return v;
    },
    bit() {
      if (n === 0) { top(1); if (n === 0) return fail(BrotliError.Truncated(pos)); }
      const v = buf & 1;
      buf >>>= 1; n--;
      return v;
    },
    /** Next k bits without consuming; zero-padded past the end of input. */
    peek(/** @type {number} */ k) { top(k); return buf & ((1 << k) - 1); },
    /** Bits actually available (≤ 31) after a peek. */
    get avail() { return n; },
    drop(/** @type {number} */ k) {
      if (k > n) { fail(BrotliError.Truncated(pos)); return; }
      buf >>>= k; n -= k;
    },
    /** Skip to the byte boundary; skipped bits must be zero (§9.2). */
    align() {
      const k = n & 7;
      if (k && (buf & ((1 << k) - 1))) { fail(BrotliError.Invalid('nonzero padding', pos)); return; }
      buf >>>= k; n -= k;
    },
    /** Byte-aligned raw copy (call after align). */
    bytes(/** @type {number} */ len) {
      // Check before allocating: `len` comes from the stream.
      if (bad || pos + len - Math.min(n >> 3, len) > src.length) { fail(BrotliError.Truncated(pos)); return EMPTY; }
      const out = new Uint8Array(len);
      let i = 0;
      while (n >= 8 && i < len) { out[i++] = buf & 255; buf >>>= 8; n -= 8; }
      out.set(src.subarray(pos, pos + len - i), i);
      pos += len - i;
      return out;
    },
    get pos() { return pos; },
    /** Unconsumed bits of the final byte must be zero; no bytes may follow. */
    cleanEnd() { return (n < 8 ? (buf & ((1 << n) - 1)) === 0 : false) && pos === src.length; },
  };
}
/** @typedef {ReturnType<typeof bitReader>} Bits */

// --- prefix codes (§3) -----------------------------------------------------

/**
 * Canonical prefix code. Decoding walks lengths 1..15 (puff-style), with an
 * 8-bit first-level table for speed. A code with one used symbol costs 0 bits.
 * @typedef {{ single: number, count: Uint16Array, symbols: Uint16Array, fast: Int32Array }} Huff
 */

const FAST = 8;
const EMPTY = new Uint8Array(0);
/** Stand-in returned after a fault: decodes symbol 0 in 0 bits, so faulted loops end fast. @type {Huff} */
const DEAD = Object.freeze({ single: 0, count: new Uint16Array(16), symbols: new Uint16Array(0), fast: new Int32Array(0) });

/** @param {Bits} br @param {Uint8Array} lengths @param {number} at @returns {Huff} */
function buildHuffman(br, lengths, at) {
  if (br.bad) return DEAD;
  const count = new Uint16Array(16);
  let used = 0, last = 0;
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) { count[lengths[s]]++; used++; last = s; }
  if (used === 0) { br.fail(BrotliError.Invalid('empty prefix code', at)); return DEAD; }
  if (used === 1) return { single: last, count, symbols: new Uint16Array(0), fast: new Int32Array(0) };
  const offs = new Uint16Array(16);
  for (let l = 1; l < 16; l++) offs[l] = offs[l - 1] + count[l - 1];
  const symbols = new Uint16Array(used);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  // Fast table: for every 8-bit prefix (bits in stream order), the symbol and its length if ≤ 8.
  const fast = new Int32Array(1 << FAST).fill(-1);
  let code = 0, idx = 0;
  for (let l = 1; l <= FAST; l++) {
    for (let k = 0; k < count[l]; k++, code++, idx++) {
      // Stream order is MSB-of-code first; the reader delivers bits LSB-first, so reverse.
      let rev = 0;
      for (let b = 0; b < l; b++) rev |= ((code >> (l - 1 - b)) & 1) << b;
      for (let fill = rev; fill < 1 << FAST; fill += 1 << l) fast[fill] = (symbols[idx] << 4) | l;
    }
    code <<= 1;
  }
  return { single: -1, count, symbols, fast };
}

/** @param {Bits} br @param {Huff} h */
function decodeSym(br, h) {
  if (h.single >= 0) return h.single;
  const e = h.fast[br.peek(FAST)];
  if (e >= 0 && (e & 15) <= br.avail) { br.drop(e & 15); return e >> 4; }
  // Longer than FAST bits (or near end of input): canonical walk, bit by bit.
  let code = 0, first = 0, index = 0;
  for (let len = 1; len < 16; len++) {
    code |= br.bit();
    const c = h.count[len];
    if (code - first < c) return h.symbols[index + code - first];
    index += c; first += c;
    first <<= 1; code <<= 1;
  }
  return br.fail(BrotliError.Invalid('prefix code overrun', br.pos));
}

/**
 * Read a prefix code over an alphabet of `size` symbols (§3.4 simple, §3.5 complex).
 * @param {Bits} br @param {number} size
 */
function readHuffman(br, size) {
  const at = br.pos;
  const lengths = new Uint8Array(size);
  const hskip = br.bits(2);
  if (hskip === 1) {
    let bits = 0;
    while ((1 << bits) < size) bits++;
    const nsym = br.bits(2) + 1;
    /** @type {number[]} */
    const syms = [];
    for (let i = 0; i < nsym; i++) {
      const s = br.bits(bits);
      if (br.bad) return DEAD;
      if (s >= size || syms.includes(s)) { br.fail(BrotliError.Invalid('simple code symbol', at)); return DEAD; }
      syms.push(s);
    }
    if (nsym === 1) lengths[syms[0]] = 1; // single symbol: buildHuffman makes it 0-bit
    else if (nsym === 2) { lengths[syms[0]] = 1; lengths[syms[1]] = 1; }
    else if (nsym === 3) { lengths[syms[0]] = 1; lengths[syms[1]] = 2; lengths[syms[2]] = 2; }
    else if (br.bit() === 0) syms.forEach((s) => { lengths[s] = 2; });
    else { lengths[syms[0]] = 1; lengths[syms[1]] = 2; lengths[syms[2]] = 3; lengths[syms[3]] = 3; }
    return buildHuffman(br, lengths, at);
  }
  // Complex: code lengths of the code-length alphabet, in CODE_LENGTH_ORDER.
  const clLengths = new Uint8Array(18);
  let space = 32, numCodes = 0;
  for (let i = hskip; i < 18; i++) {
    const ix = br.peek(4);
    br.drop(CL_LEN[ix]);
    const v = CL_VAL[ix];
    clLengths[CODE_LENGTH_ORDER[i]] = v;
    if (v !== 0) {
      space -= 32 >> v;
      numCodes++;
      if (space <= 0) break;
    }
  }
  if (br.bad) return DEAD;
  if (!(numCodes === 1 || space === 0)) { br.fail(BrotliError.Invalid('code length code', at)); return DEAD; }
  const clHuff = buildHuffman(br, clLengths, at);
  let sym = 0, prev = 8, repeat = 0, repeatLen = 0;
  space = 32768;
  while (sym < size && space > 0 && !br.bad) {
    const p = decodeSym(br, clHuff);
    if (p < 16) {
      repeat = 0;
      lengths[sym++] = p;
      if (p !== 0) { prev = p; space -= 32768 >> p; }
    } else {
      const extra = p === 16 ? 2 : 3;
      const newLen = p === 16 ? prev : 0;
      if (repeatLen !== newLen) { repeat = 0; repeatLen = newLen; }
      const old = repeat;
      if (repeat > 0) repeat = (repeat - 2) << extra;
      repeat += br.bits(extra) + 3;
      const delta = repeat - old;
      if (sym + delta > size) { br.fail(BrotliError.Invalid('code length repeat overflow', at)); return DEAD; }
      for (let k = 0; k < delta; k++) lengths[sym++] = repeatLen;
      if (repeatLen !== 0) space -= delta * (32768 >> repeatLen);
    }
  }
  if (br.bad) return DEAD;
  if (space !== 0) { br.fail(BrotliError.Invalid('incomplete prefix code', at)); return DEAD; }
  return buildHuffman(br, lengths, at);
}

// --- small codes -----------------------------------------------------------

/** §9.2 NBLTYPES / NTREES varint: 0..255. @param {Bits} br */
const varLen8 = (br) => {
  if (!br.bit()) return 0;
  const n = br.bits(3);
  return n === 0 ? 1 : (1 << n) + br.bits(n);
};

/** @param {Bits} br @param {Huff} h */
const blockLength = (br, h) => {
  const c = decodeSym(br, h);
  return BLEN_BASE[c] + br.bits(BLEN_EXTRA[c]);
};

/** §7.3 context map with RLE and optional inverse move-to-front. @param {Bits} br @param {number} size @param {number} ntrees */
function contextMap(br, size, ntrees) {
  const map = new Uint8Array(size);
  if (ntrees < 2) return map;
  const rleMax = br.bit() ? br.bits(4) + 1 : 0;
  const h = readHuffman(br, ntrees + rleMax);
  for (let i = 0; i < size && !br.bad;) {
    const s = decodeSym(br, h);
    if (s === 0) map[i++] = 0;
    else if (s <= rleMax) {
      let reps = (1 << s) + br.bits(s);
      if (i + reps > size) { br.fail(BrotliError.Invalid('context map RLE overflow', br.pos)); break; }
      while (reps--) map[i++] = 0;
    } else map[i++] = s - rleMax;
  }
  if (br.bit()) {
    const mtf = Array.from({ length: 256 }, (_, k) => k);
    for (let i = 0; i < size; i++) {
      const idx = map[i], v = mtf[idx];
      map[i] = v;
      mtf.splice(idx, 1);
      mtf.unshift(v);
    }
  }
  return map;
}

// --- dictionary words (§8) -------------------------------------------------

/** @param {Uint8Array} w @param {number} i */
const upper = (w, i) => {
  if (w[i] < 0xc0) { if (w[i] >= 97 && w[i] <= 122) w[i] ^= 32; return 1; }
  if (w[i] < 0xe0) { if (i + 1 < w.length) w[i + 1] ^= 32; return 2; }
  if (i + 2 < w.length) w[i + 2] ^= 5;
  return 3;
};

/** @param {Bits} br @param {number} len @param {number} wordId @param {number} at */
function dictionaryWord(br, len, wordId, at) {
  if (len < 4 || len > 24 || NDBITS[len] === 0) { br.fail(BrotliError.Invalid('dictionary word length', at)); return EMPTY; }
  const nbits = NDBITS[len];
  const idx = wordId & ((1 << nbits) - 1);
  const t = wordId >>> nbits;
  if (t >= TRANSFORMS.length) { br.fail(BrotliError.Invalid('transform id', at)); return EMPTY; }
  const start = DICT_OFFSETS[len] + idx * len;
  const [prefix, type, suffix] = TRANSFORMS[t];
  let word = dict().slice(start, start + len);
  if (type >= 1 && type <= 9) word = word.subarray(0, Math.max(0, len - type));
  else if (type >= 12 && type <= 20) word = word.subarray(Math.min(len, type - 11));
  else if (type === 10) { if (word.length) upper(word, 0); }
  else if (type === 11) { for (let i = 0; i < word.length;) i += upper(word, i); }
  const out = new Uint8Array(prefix.length + word.length + suffix.length);
  out.set(prefix); out.set(word, prefix.length); out.set(suffix, prefix.length + word.length);
  return out;
}

// --- the decoder -----------------------------------------------------------

/**
 * @param {Uint8Array} input
 * @param {{ sizeHint?: number, maxOutput?: number, span?: import('../../otel-compact/src/trace.js').Span }} [opts]
 * @returns {import('../../otel-compact/src/adt.js').Result<Uint8Array, any>}
 */
export function brotliDecode(input, { sizeHint = 0, maxOutput = 1 << 30, span = NOOP_SPAN } = {}) {
  const br = bitReader(input);
  let out = new Uint8Array(Math.max(1024, sizeHint));
  let pos = 0;
  /** Room for `extra` more bytes, or a fault past maxOutput. @returns {boolean} */
  const ensure = (/** @type {number} */ extra) => {
    if (pos + extra > maxOutput) { br.fail(BrotliError.Invalid('output exceeds maxOutput', br.pos)); return false; }
    if (pos + extra <= out.length) return true;
    let n = out.length * 2;
    while (n < pos + extra) n *= 2;
    const o = new Uint8Array(n);
    o.set(out.subarray(0, pos));
    out = o;
    return true;
  };

  {
    // §9.1 stream header: window bits.
    let wbits;
    if (!br.bit()) wbits = 16;
    else {
      const n = br.bits(3);
      if (n) wbits = 17 + n;
      else {
        const m = br.bits(3);
        if (m === 1) return err(BrotliError.Invalid('large-window brotli', 0));
        wbits = m ? 8 + m : 17;
      }
    }
    const window = (1 << wbits) - 16;
    const ring = [16, 15, 11, 4]; // ring[3] is the last distance
    let rp = 3;

    // Every loop below also stops on a fault: reads return 0 after one, so without the check a
    // faulted `last` bit would read 0 forever.
    for (let last = 0; !last && !br.bad;) {
      // §9.2 meta-block header
      last = br.bit();
      if (last && br.bit()) break; // ISLASTEMPTY
      const nibbles = br.bits(2);
      if (nibbles === 3) {
        if (br.bit()) { br.fail(BrotliError.Invalid('reserved bit', br.pos)); break; }
        const skipBytes = br.bits(2);
        let skip = 0;
        for (let i = 0; i < skipBytes; i++) {
          const b = br.bits(8);
          if (i === skipBytes - 1 && skipBytes > 1 && b === 0) br.fail(BrotliError.Invalid('MSKIPLEN', br.pos));
          skip |= b << (8 * i);
        }
        if (skipBytes) skip += 1;
        br.align();
        br.bytes(skip);
        continue;
      }
      const nn = nibbles + 4;
      let mlen = 0;
      for (let i = 0; i < nn; i++) {
        const nib = br.bits(4);
        if (i === nn - 1 && nn > 4 && nib === 0) br.fail(BrotliError.Invalid('MLEN nibble', br.pos));
        mlen |= nib << (4 * i);
      }
      mlen += 1;
      if (br.bad) break;
      if (!last && br.bit()) { // ISUNCOMPRESSED
        br.align();
        const raw = br.bytes(mlen);
        if (br.bad || !ensure(mlen)) break;
        out.set(raw, pos);
        pos += mlen;
        continue;
      }

      // Prefix codes and context maps for this meta-block (§9.2).
      const { nbl, btHuff, blHuff, blen, btype, prevType, npostfix, ndirect, postfixMask, cmode, cmapL, cmapD, hL, hI, hD } =
        span.span('brotli.codes', { mlen }, (cs) => {
        // §9.2 block types and counts per category: 0 literal, 1 insert&copy, 2 distance.
        const nbl = [0, 0, 0], btHuff = /** @type {Huff[]} */ ([]), blHuff = /** @type {Huff[]} */ ([]);
        const blen = [1 << 24, 1 << 24, 1 << 24], btype = [0, 0, 0], prevType = [1, 1, 1];
        for (let c = 0; c < 3; c++) {
          nbl[c] = varLen8(br) + 1;
          if (nbl[c] >= 2) {
            btHuff[c] = readHuffman(br, nbl[c] + 2);
            blHuff[c] = readHuffman(br, 26);
            blen[c] = blockLength(br, blHuff[c]);
          }
        }
        const npostfix = br.bits(2);
        const ndirect = br.bits(4) << npostfix;
        const postfixMask = (1 << npostfix) - 1;
        const cmode = new Uint8Array(nbl[0]);
        for (let i = 0; i < nbl[0]; i++) cmode[i] = br.bits(2);
        const ntreesL = varLen8(br) + 1;
        const cmapL = contextMap(br, 64 * nbl[0], ntreesL);
        const ntreesD = varLen8(br) + 1;
        const cmapD = contextMap(br, 4 * nbl[2], ntreesD);
        const hL = Array.from({ length: ntreesL }, () => readHuffman(br, 256));
        const hI = Array.from({ length: nbl[1] }, () => readHuffman(br, 704));
        const hD = Array.from({ length: ntreesD }, () => readHuffman(br, 16 + ndirect + (48 << npostfix)));
        cs.set('trees', ntreesL + nbl[1] + ntreesD);
        return { nbl, btHuff, blHuff, blen, btype, prevType, npostfix, ndirect, postfixMask, cmode, cmapL, cmapD, hL, hI, hD };
      });
      if (br.bad) break;

      /** Block switch (§6) for category c. */
      const switchBlock = (/** @type {number} */ c) => {
        const s = decodeSym(br, btHuff[c]);
        let t = s === 0 ? prevType[c] : s === 1 ? btype[c] + 1 : s - 2;
        if (t >= nbl[c]) t -= nbl[c];
        prevType[c] = btype[c];
        btype[c] = t;
        blen[c] = blockLength(br, blHuff[c]);
      };

      const end = pos + mlen;
      if (!ensure(mlen)) break;
      span.span('brotli.commands', { atomic: true, items: mlen }, () => {
      while (pos < end && !br.bad) {
        if (blen[1] === 0) switchBlock(1);
        blen[1]--;
        const cmd = decodeSym(br, hI[btype[1]]);
        const r = cmd >> 6;
        const insCode = CMD_INS_OFF[r] + ((cmd >> 3) & 7);
        const copyCode = CMD_COPY_OFF[r] + (cmd & 7);
        const insLen = INS_BASE[insCode] + br.bits(INS_EXTRA[insCode]);
        const copyLen = COPY_BASE[copyCode] + br.bits(COPY_EXTRA[copyCode]);
        if (pos + insLen > end) { br.fail(BrotliError.Invalid('insert past meta-block', br.pos)); return; }
        for (let k = 0; k < insLen; k++) {
          if (blen[0] === 0) switchBlock(0);
          blen[0]--;
          const p1 = pos > 0 ? out[pos - 1] : 0, p2 = pos > 1 ? out[pos - 2] : 0;
          const m = cmode[btype[0]] * 512;
          const ctx = CONTEXT_LOOKUP[m + p1] | CONTEXT_LOOKUP[m + 256 + p2];
          out[pos++] = decodeSym(br, hL[cmapL[btype[0] * 64 + ctx]]);
        }
        if (pos >= end) break; // §9.3: copy of the last command is ignored when MLEN is reached

        let distance, dcode = 0;
        if (r < 2) distance = ring[rp]; // implicit distance code 0
        else {
          if (blen[2] === 0) switchBlock(2);
          blen[2]--;
          const dctx = copyLen > 4 ? 3 : copyLen - 2;
          dcode = decodeSym(br, hD[cmapD[btype[2] * 4 + dctx]]);
          if (dcode < 16) {
            distance = ring[(rp - DIST_RING[dcode] + 4) & 3] + DIST_DELTA[dcode];
            if (distance <= 0) { br.fail(BrotliError.Invalid('distance ≤ 0', br.pos)); return; }
          } else if (dcode < 16 + ndirect) distance = dcode - 15;
          else {
            const d = dcode - ndirect - 16;
            const nbits = 1 + (d >> (npostfix + 1));
            const offset = ((2 + ((d >> npostfix) & 1)) << nbits) - 4;
            distance = ((offset + br.bits(nbits)) << npostfix) + (d & postfixMask) + ndirect + 1;
          }
        }
        const maxDist = Math.min(window, pos);
        if (distance > maxDist) {
          const word = dictionaryWord(br, copyLen, distance - maxDist - 1, br.pos);
          if (br.bad) return;
          if (pos + word.length > end) { br.fail(BrotliError.Invalid('dictionary word past meta-block', br.pos)); return; }
          out.set(word, pos);
          pos += word.length;
        } else {
          if (dcode !== 0) { rp = (rp + 1) & 3; ring[rp] = distance; }
          if (pos + copyLen > end) { br.fail(BrotliError.Invalid('copy past meta-block', br.pos)); return; }
          for (let k = 0; k < copyLen; k++, pos++) out[pos] = out[pos - distance];
        }
      }
      });
    }
    if (br.bad) return err(br.fault);
    if (!br.cleanEnd()) return err(BrotliError.TrailingBits);
    return ok(out.slice(0, pos));
  }
}
