// @ts-check
// Pluggable DEFLATE (RFC 1951) in a zlib wrapper (RFC 1950), streaming by construction.
//
//   zlibOf({ name, lz: Lz.Chain(32, 16, 128, 8), entropy: Entropy.Dynamic })
//
// Two ports, composed by one core:
//   Lz       match finder: Greedy (one hash probe + distance-1 run, the original `fast`)
//            | Chain(chain, lazy, nice, good, insert): hash chains with lazy evaluation, as zlib's
//              deflate_slow; positions inside matches longer than `insert` are not hashed
//              (zlib's max_insert_length), which is what keeps long background runs cheap
//   Entropy  block coder: Fixed (RFC 1951 §3.2.6 codes, one block) | Dynamic (per-block Huffman,
//            length-limited, cheaper of dynamic and fixed chosen per block by exact bit cost)
//
// Streaming: a position is only encoded once LOOK bytes past it are buffered, and the 32 KiB
// window behind it is kept, so every match decision sees the bytes a whole-buffer encode
// would see. Block boundaries are counted in symbols, not input chunks. Output is therefore
// byte-identical however the input is chunked (tested with 1-byte pushes).
import { variants } from '../../otel-compact/src/adt.js';

export const Lz = variants('Lz', {
  Greedy: [],
  Chain: ['chain', 'lazy', 'nice', 'good', 'insert'],
});
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof Lz>} LzT */
export const Entropy = variants('Entropy', { Fixed: [], Dynamic: [] });
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof Entropy>} EntropyT */

// ---- tables -------------------------------------------------------------------------------
/** Bit-reverse the low `n` bits of `c`. @param {number} c @param {number} n */
const rev = (c, n) => { let r = 0; for (let i = 0; i < n; i++) { r = (r << 1) | (c & 1); c >>= 1; } return r; };
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_IDX = new Uint8Array(259);
for (let i = 0; i < 29; i++) for (let l = LEN_BASE[i]; l < (i < 28 ? LEN_BASE[i + 1] : 259); l++) LEN_IDX[l] = i;
const DIST_LO = new Uint8Array(257), DIST_HI = new Uint8Array(256);
for (let i = 0; i < 30; i++) {
  const end = i < 29 ? DIST_BASE[i + 1] : 32769;
  for (let d = DIST_BASE[i]; d < end; d++) { if (d <= 256) DIST_LO[d] = i; else DIST_HI[(d - 1) >> 7] = i; }
}
/** @param {number} d */
const distIdx = (d) => (d <= 256 ? DIST_LO[d] : DIST_HI[(d - 1) >> 7]);
// Fixed codes, pre-reversed for the LSB-first writer.
const FIX_LIT = new Uint16Array(288), FIX_LEN = new Uint8Array(288);
for (let s = 0; s < 288; s++) {
  const [base, len, first] = s < 144 ? [0x30, 8, 0] : s < 256 ? [0x190, 9, 144] : s < 280 ? [0, 7, 256] : [0xc0, 8, 280];
  FIX_LIT[s] = rev(base + s - first, len); FIX_LEN[s] = len;
}
const FIX_DIST = Uint16Array.from({ length: 30 }, (_, i) => rev(i, 5));
const FIX_DLEN = new Uint8Array(30).fill(5);
/** Code-length code order (RFC 1951 §3.2.7). */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// ---- Huffman ------------------------------------------------------------------------------
/**
 * Huffman code lengths for `freq`, no longer than `limit` bits.
 * Two-queue Huffman on sorted leaves (O(n) after the sort). If the tree is too deep, the
 * frequencies are halved (kept ≥ 1) and the tree rebuilt: every result is a real Huffman
 * tree, hence a complete prefix code, which zlib's inflater requires. Always codes at least
 * two symbols, since a one-symbol code is incomplete.
 * @param {Uint32Array} freq @param {number} limit @returns {Uint8Array}
 */
export function huffLengths(freq, limit) {
  const n = freq.length, lens = new Uint8Array(n);
  /** @type {number[]} */
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i]) syms.push(i);
  if (syms.length === 0) { lens[0] = 1; lens[1] = 1; return lens; }
  if (syms.length === 1) { lens[syms[0]] = 1; lens[syms[0] === 0 ? 1 : 0] = 1; return lens; }
  const m = syms.length;
  const f = Float64Array.from(syms, (x) => freq[x]);
  const w = new Float64Array(2 * m), parent = new Int32Array(2 * m), depth = new Uint8Array(2 * m);
  for (;;) {
    const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => f[a] - f[b] || syms[a] - syms[b]);
    for (let i = 0; i < m; i++) w[i] = f[order[i]];
    let leaf = 0, inner = m, next = m;
    const pick = () => (leaf < m && (inner >= next || w[leaf] <= w[inner]) ? leaf++ : inner++);
    while (next < 2 * m - 1) { const a = pick(), b = pick(); w[next] = w[a] + w[b]; parent[a] = parent[b] = next; next++; }
    depth[2 * m - 2] = 0;
    let max = 0;
    for (let i = 2 * m - 3; i >= 0; i--) { depth[i] = depth[parent[i]] + 1; if (i < m && depth[i] > max) max = depth[i]; }
    if (max <= limit) { for (let i = 0; i < m; i++) lens[syms[order[i]]] = depth[i]; return lens; }
    for (let i = 0; i < m; i++) f[i] = Math.max(1, Math.floor(f[i] / 2));
  }
}

/** Canonical codes from lengths (RFC 1951 §3.2.2), bit-reversed. @param {Uint8Array} lens */
function canonical(lens) {
  const max = Math.max(...lens), blc = new Uint16Array(max + 2), nextCode = new Uint16Array(max + 2);
  for (const l of lens) if (l) blc[l]++;
  for (let code = 0, b = 1; b <= max; b++) { code = (code + blc[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint16Array(lens.length);
  for (let i = 0; i < lens.length; i++) if (lens[i]) codes[i] = rev(nextCode[lens[i]]++, lens[i]);
  return codes;
}

// ---- core ---------------------------------------------------------------------------------
const WIN = 32768, WMASK = WIN - 1, HB = 15, BLOCK = 1 << 14;

/**
 * @typedef {object} Deflater
 * @property {(raw: Uint8Array) => Uint8Array} push   compressed bytes final so far
 * @property {() => Uint8Array} finish                the rest, Adler-32 trailer included
 */

/**
 * @param {{ lz: LzT, entropy: EntropyT, blockBytes?: number }} cfg   blockBytes: also end a block every N input bytes (Dynamic)
 * @param {(b: Uint8Array, prev: number) => number} adler32
 * @returns {Deflater}
 */
export function deflater({ lz, entropy, blockBytes = Infinity }, adler32) {
  const greedy = lz.tag === 'Greedy';
  const LOOK = greedy ? 258 : 262; // lazy evaluation looks one position further, plus hash bytes
  const chainMax = lz.tag === 'Chain' ? lz.chain : 0, lazyMax = lz.tag === 'Chain' ? lz.lazy : 0;
  const nice = lz.tag === 'Chain' ? lz.nice : 258, good = lz.tag === 'Chain' ? lz.good : 0, insertMax = lz.tag === 'Chain' ? lz.insert : 0;
  let buf = new Uint8Array(1 << 16), base = 0, len = 0, p = 0, ad = 1;
  const head = new Int32Array(1 << HB).fill(-1), prev = new Int32Array(WIN).fill(-1);
  // Symbol buffer: L = literal byte or 256 + match length; D = distance (0 for a literal).
  const L = new Uint16Array(BLOCK), D = new Uint16Array(BLOCK);
  let ns = 0;
  // Input bytes the buffered symbols cover. A block also ends at `blockBytes` of input: block
  // boundaries then depend only on the symbol sequence (identical however the input is chunked),
  // and a streamed PNG gets a block, so new rows on screen, every ~blockBytes of pixels.
  let covered = 0;
  // Lazy-matching state that carries across pushes.
  let prevLen = 0, prevDist = 0, pending = false;

  // Bit writer.
  let out = new Uint8Array(1 << 12), o = 0, bits = 0, nb = 0;
  /** @param {number} v @param {number} k */
  const put = (v, k) => {
    bits |= v << nb; nb += k;
    while (nb >= 8) {
      if (o >= out.length) { const g = new Uint8Array(out.length * 2); g.set(out); out = g; }
      out[o++] = bits & 255; bits >>>= 8; nb -= 8;
    }
  };
  out[0] = 0x78; out[1] = 0x01; o = 2;
  if (entropy.tag === 'Fixed') { put(1, 1); put(1, 2); } // one fixed block, BFINAL set up front

  /** @param {Uint16Array} lc @param {Uint8Array} ll @param {Uint16Array} dc @param {Uint8Array} dl */
  const symbols = (lc, ll, dc, dl) => {
    for (let i = 0; i < ns; i++) {
      const s = L[i];
      if (s < 256) { put(lc[s], ll[s]); continue; }
      const len = s - 256, li = LEN_IDX[len];
      put(lc[257 + li], ll[257 + li]);
      if (LEN_EXTRA[li]) put(len - LEN_BASE[li], LEN_EXTRA[li]);
      const d = D[i], di = distIdx(d);
      put(dc[di], dl[di]);
      if (DIST_EXTRA[di]) put(d - DIST_BASE[di], DIST_EXTRA[di]);
    }
  };

  /** Emit the buffered symbols as a block (Dynamic) or as more of the one block (Fixed). @param {boolean} final */
  const flush = (final) => {
    if (entropy.tag === 'Fixed') {
      symbols(FIX_LIT, FIX_LEN, FIX_DIST, FIX_DLEN);
      if (final) put(FIX_LIT[256], FIX_LEN[256]);
      ns = 0; covered = 0;
      return;
    }
    const lf = new Uint32Array(286), df = new Uint32Array(30);
    for (let i = 0; i < ns; i++) {
      const s = L[i];
      if (s < 256) { lf[s]++; continue; }
      const li = LEN_IDX[s - 256], di = distIdx(D[i]);
      lf[257 + li]++; df[di]++; // extra bits cost the same under both codes
    }
    lf[256] = 1;
    const ll = huffLengths(lf, 15), dl = huffLengths(df, 15);
    let hlit = 286; while (hlit > 257 && ll[hlit - 1] === 0) hlit--;
    let hdist = 30; while (hdist > 1 && dl[hdist - 1] === 0) hdist--;
    // Run-length encode the code lengths (16: repeat previous 3–6, 17: zeros 3–10, 18: zeros 11–138).
    const seq = [...ll.subarray(0, hlit), ...dl.subarray(0, hdist)];
    /** @type {[number, number][]} */
    const rle = [];
    for (let i = 0; i < seq.length;) {
      const v = seq[i];
      let r = 1; while (i + r < seq.length && seq[i + r] === v) r++;
      let k = r;
      if (v === 0) {
        while (k >= 11) { const t = Math.min(138, k); rle.push([18, t - 11]); k -= t; }
        if (k >= 3) { rle.push([17, k - 3]); k = 0; }
      } else {
        rle.push([v, 0]); k--;
        while (k >= 3) { const t = Math.min(6, k); rle.push([16, t - 3]); k -= t; }
      }
      for (; k > 0; k--) rle.push([v, 0]);
      i += r;
    }
    const cf = new Uint32Array(19);
    for (const [c] of rle) cf[c]++;
    const cl = huffLengths(cf, 7), cc = canonical(cl);
    let hclen = 19; while (hclen > 4 && cl[CL_ORDER[hclen - 1]] === 0) hclen--;
    // Exact bit costs of both encodings of this block.
    let dyn = 3 + 5 + 5 + 4 + 3 * hclen, fix = 3;
    for (const [c] of rle) dyn += cl[c] + (c === 16 ? 2 : c === 17 ? 3 : c === 18 ? 7 : 0);
    for (let s = 0; s < 286; s++) if (lf[s]) { dyn += lf[s] * ll[s]; fix += lf[s] * FIX_LEN[s]; }
    for (let d = 0; d < 30; d++) if (df[d]) { dyn += df[d] * dl[d]; fix += df[d] * 5; }
    put(final ? 1 : 0, 1);
    if (fix <= dyn) {
      put(1, 2);
      symbols(FIX_LIT, FIX_LEN, FIX_DIST, FIX_DLEN);
      put(FIX_LIT[256], FIX_LEN[256]);
    } else {
      put(2, 2);
      put(hlit - 257, 5); put(hdist - 1, 5); put(hclen - 4, 4);
      for (let i = 0; i < hclen; i++) put(cl[CL_ORDER[i]], 3);
      for (const [c, x] of rle) { put(cc[c], cl[c]); if (c === 16) put(x, 2); else if (c === 17) put(x, 3); else if (c === 18) put(x, 7); }
      const lc = canonical(ll), dc = canonical(dl);
      symbols(lc, ll, dc, dl);
      put(lc[256], ll[256]);
    }
    ns = 0; covered = 0;
  };

  /** @param {boolean} final */
  const encode = (final) => {
    const src = buf, b = base, n = len, stop = final ? n : n - LOOK;
    /** @param {number} q */
    const hash = (q) => Math.imul((src[q - b] << 16) | (src[q - b + 1] << 8) | src[q - b + 2], 0x9e3779b1) >>> (32 - HB);
    /** Insert position q into the hash chains (Chain only). @param {number} q */
    const insert = (q) => { if (q + 3 <= n) { const h = hash(q); prev[q & WMASK] = head[h]; head[h] = q; } };
    /**
     * Longest match at q of at least `min + 1`, walking up to `chain` candidates.
     * Returns length · 65536 + distance (0 if none).
     * @param {number} q @param {number} min @param {number} chain
     */
    const longest = (q, min, chain) => {
      const max = Math.min(258, n - q), i = q - b;
      if (max < 3) return 0;
      let bestLen = min, bestDist = 0;
      // Distance-1 run: flat backgrounds are long runs of one byte.
      if (q > 0 && src[i - 1] === src[i] && src[i] === src[i + 1] && src[i] === src[i + 2]) {
        let l = 3; const c = src[i]; while (l < max && src[i + l] === c) l++;
        if (l > bestLen) { bestLen = l; bestDist = 1; }
      }
      if (bestLen >= nice) return bestLen * 65536 + bestDist;
      let cand = head[hash(q)];
      for (let k = chain; k > 0 && cand >= 0 && q - cand <= WIN && cand < q; k--) {
        const j = cand - b;
        if (src[j + bestLen] === src[i + bestLen] && src[j] === src[i] && src[j + 1] === src[i + 1]) {
          let l = 2; while (l < max && src[j + l] === src[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = q - cand; if (l >= nice) break; }
        }
        const nx = prev[cand & WMASK];
        if (nx >= cand) break; // slot reused by a newer position: chain ends
        cand = nx;
      }
      return bestDist ? bestLen * 65536 + bestDist : 0;
    };
    /** @param {number} c */
    const lit = (c) => { L[ns] = c; D[ns] = 0; covered++; if (++ns === BLOCK || covered >= blockBytes) flush(false); };
    /** @param {number} l @param {number} d */
    const match = (l, d) => { L[ns] = 256 + l; D[ns] = d; covered += l; if (++ns === BLOCK || covered >= blockBytes) flush(false); };

    if (greedy) {
      // The original fast encoder, decision for decision: one probe, head-only table.
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
        if (bestLen >= 3) { match(bestLen, bestDist); p += bestLen; } else { lit(src[i]); p++; }
      }
      return;
    }
    // Lazy evaluation (zlib deflate_slow): hold the match at p−1, take it unless p does better.
    while (p < stop) {
      let curLen = 0, curDist = 0;
      if (!pending || prevLen < lazyMax) {
        const r = longest(p, pending ? Math.max(2, prevLen) : 2, pending && prevLen >= good ? chainMax >> 2 : chainMax);
        curLen = Math.floor(r / 65536); curDist = r % 65536;
      }
      insert(p);
      if (pending && prevLen >= 3 && curLen <= prevLen) {
        match(prevLen, prevDist);
        // Positions inside the match (p−1 already inserted, p just now) join the chains.
        const end = p - 1 + prevLen;
        // Inside a distance-1 run every position hashes the same bytes: only the tail, where the
        // run meets new content, is worth a chain entry.
        // Longer matches: every 4th position, which still lets a later copy of this content
        // (typically the next pixel row) find it, at most 3 bytes late.
        if (prevDist === 1) for (let q = Math.max(p + 1, end - 2); q < end; q++) insert(q);
        else if (prevLen <= insertMax) for (let q = p + 1; q < end; q++) insert(q);
        else { for (let q = p + 1; q < end; q += 4) insert(q); if (end - 1 > p) insert(end - 1); }
        p = end; pending = false; prevLen = 0;
        continue;
      }
      if (pending) lit(src[p - 1 - b]);
      pending = true; prevLen = curLen; prevDist = curDist;
      p++;
    }
    if (final && pending) { lit(src[p - 1 - b]); pending = false; }
  };

  const drain = () => { const r = out.slice(0, o); o = 0; return r; };
  return {
    push(raw) {
      ad = adler32(raw, ad);
      const keep = Math.max(base, p - WIN - 2);
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
    finish() {
      encode(true);
      flush(true);
      if (nb > 0) put(0, 8 - nb);
      const t = drain(), r = new Uint8Array(t.length + 4);
      r.set(t); r.set([ad >>> 24, (ad >>> 16) & 255, (ad >>> 8) & 255, ad & 255], t.length);
      return r;
    },
  };
}
