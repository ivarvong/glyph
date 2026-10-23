// @ts-check
// Legacy 'kern' table (OpenType version 0, format 0 subtables): pair kerning for fonts that have
// no GPOS kerning. HarfBuzz applies it in exactly that case, and so does glyph now. Found by
// the corpus differential (Google Fonts: Rancho and others ship only a 'kern' table).
//
//   u16 version (0) · u16 nTables · subtables: u16 version · u16 length · u16 coverage ·
//   format 0: u16 nPairs · u16 searchRange · u16 entrySelector · u16 rangeShift · {u16 left, u16 right, i16 value}[nPairs]
//
// Coverage bit 0 horizontal, bit 2 cross-stream; format in the high byte. As in HarfBuzz
// (hb-ot-kern-table.hh, hb-kern.hh): only horizontal, non-cross-stream subtables kern
// horizontal text; each subtable is applied on its own; Minimum and Override are not honoured.
// Apple's version-1 'kern' and other formats are ignored (no kerning, not an error).
import { ok } from '../../otel-compact/src/adt.js';
import { view, u16, i16, fits, guard } from '../../sfnt/src/bin.js';

/** @typedef {(left: number, right: number) => number} Kerner */

/**
 * @param {Uint8Array} b
 * @returns {import('../../otel-compact/src/adt.js').Result<Kerner[], any>}
 */
export function parseKern(b) {
  const v = view(b);
  const r = guard(() => {
    if (u16(v, 0) !== 0) return /** @type {Kerner[]} */ ([]); // Apple 'kern' (version 1.0): not supported
    const n = u16(v, 2);
    /** @type {Kerner[]} */
    const out = [];
    let o = 4;
    for (let t = 0; t < n && o + 6 <= b.length; t++) {
      const length = u16(v, o + 2), coverage = u16(v, o + 4);
      const format = coverage >> 8, horizontal = (coverage & 1) !== 0, cross = (coverage & 4) !== 0;
      if (format === 0 && horizontal && !cross) {
        const nPairs = u16(v, o + 6), base = o + 14;
        // The pairs must be there before lookups trust them: afterwards every read is in range.
        if (fits(v, base, nPairs * 6)) out.push(pairs(v, base, nPairs));
      }
      if (length < 6) break; // a zero or bogus length would loop; stop where the table stops making sense
      o += length;
    }
    return out;
  }, () => 'truncated');
  return r.tag === 'Ok' ? r : ok([]);
}

/** Binary search over sorted (left << 16 | right) keys, reading in place. @param {import("../../sfnt/src/bin.js").View} v @param {number} base @param {number} n @returns {Kerner} */
function pairs(v, base, n) {
  return (left, right) => {
    const key = left * 65536 + right;
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, at = base + m * 6;
      const k = u16(v, at) * 65536 + u16(v, at + 2);
      if (k === key) return i16(v, at + 4);
      if (k < key) lo = m + 1; else hi = m - 1;
    }
    return 0;
  };
}

/**
 * Apply each subtable as HarfBuzz's kern machine does: pair each non-mark glyph with the next
 * non-mark glyph; split the value, kern >> 1 to the first glyph's advance and the rest to the
 * second glyph's advance and x offset.
 * @param {Kerner[]} subtables
 * @param {import('./shape.js').PositionedGlyph[]} buf
 * @param {(i: number) => boolean} isMark  by buffer position (GDEF class, or synthesised)
 */
export function applyKern(subtables, buf, isMark) {
  for (const kern of subtables) {
    for (let i = 0; i < buf.length;) {
      if (isMark(i)) { i++; continue; }
      let j = i + 1;
      while (j < buf.length && isMark(j)) j++;
      if (j >= buf.length) break;
      const k = kern(buf[i].gid, buf[j].gid);
      if (k) {
        const k1 = k >> 1, k2 = k - k1;
        buf[i].ax += k1; buf[j].ax += k2; buf[j].dx += k2;
      }
      i = j;
    }
  }
}
