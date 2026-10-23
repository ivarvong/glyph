// @ts-check
// Metric and mapping tables. Each parser: (Uint8Array) -> Result<Record, TableError>.

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import { view, u16, i16, u32, guard, times, fits } from './bin.js';

export const TableError = variants('TableError', {
  Missing: ['table'],
  Truncated: ['table', 'at'],
  Invalid: ['table', 'reason'],
  NoUnicodeCmap: [],
});

/** @param {string} t */
const bounds = (t) => (/** @type {import('./bin.js').Fault} */ f) => TableError.Truncated(t, f.at);

/** @param {Uint8Array} b */
export const parseHead = (b) => {
  const v = view(b);
  const r = guard(() => ({
    magic: u32(v, 12),
    unitsPerEm: u16(v, 18),
    bbox: [i16(v, 36), i16(v, 38), i16(v, 40), i16(v, 42)],
    indexToLocFormat: /** @type {0 | 1} */ (i16(v, 50)),
  }), bounds('head'));
  if (r.tag === 'Ok' && r.value.magic !== 0x5f0f3cf5) return err(TableError.Invalid('head', 'magicNumber'));
  if (r.tag === 'Ok' && (r.value.unitsPerEm < 16 || r.value.unitsPerEm > 16384)) return err(TableError.Invalid('head', 'unitsPerEm'));
  return r;
};

/** @param {Uint8Array} b */
export const parseHhea = (b) => {
  const v = view(b);
  return guard(() => ({ ascender: i16(v, 4), descender: i16(v, 6), lineGap: i16(v, 8), numberOfHMetrics: u16(v, 34) }), bounds('hhea'));
};

/** @param {Uint8Array} b */
export const parseMaxp = (b) => guard(() => ({ numGlyphs: u16(view(b), 4) }), bounds('maxp'));

/**
 * Advance widths. Glyphs past numberOfHMetrics repeat the last advance.
 * @param {Uint8Array} b @param {number} numberOfHMetrics @param {number} numGlyphs
 */
export const parseHmtx = (b, numberOfHMetrics, numGlyphs) => {
  if (numberOfHMetrics === 0 || numberOfHMetrics > numGlyphs) return err(TableError.Invalid('hhea', `numberOfHMetrics ${numberOfHMetrics}`));
  const v = view(b);
  return guard(() => {
    const adv = new Uint16Array(numGlyphs);
    for (let g = 0; g < numGlyphs; g++) adv[g] = g < numberOfHMetrics ? u16(v, g * 4) : adv[numberOfHMetrics - 1];
    return adv;
  }, bounds('hmtx'));
};

/**
 * Left side bearings: [numberOfHMetrics] long metrics, then the trailing lsb array.
 * @param {Uint8Array} b @param {number} numberOfHMetrics @param {number} numGlyphs
 */
export const parseLsb = (b, numberOfHMetrics, numGlyphs) => {
  const v = view(b);
  return guard(() => {
    const lsb = new Int16Array(numGlyphs);
    for (let g = 0; g < numGlyphs; g++) lsb[g] = g < numberOfHMetrics ? i16(v, g * 4 + 2) : i16(v, numberOfHMetrics * 4 + (g - numberOfHMetrics) * 2);
    return lsb;
  }, bounds('hmtx'));
};

// ---------------------------------------------------------------------------
// cmap. Two subtable formats, one interface: (codepoint) -> glyph id (0 = .notdef).

export const CmapFormat = variants('CmapFormat', { F4: ['offset'], F12: ['offset'] });

/**
 * Unicode subtables we can read, best first (full repertoire before BMP).
 * @param {Uint8Array} b
 */
export function cmapCandidates(b) {
  const v = view(b);
  return guard(() => {
    const n = u16(v, 2);
    const recs = times(n, (i) => ({
      platform: u16(v, 4 + i * 8), encoding: u16(v, 6 + i * 8), offset: u32(v, 8 + i * 8),
    }));
    const rank = (/** @type {{platform:number, encoding:number}} */ r) =>
      r.platform === 3 && r.encoding === 10 ? 0 : r.platform === 0 && (r.encoding === 4 || r.encoding === 6) ? 1
        : r.platform === 3 && r.encoding === 1 ? 2 : r.platform === 0 ? 3 : 99;
    return recs
      .filter((r) => rank(r) < 99)
      .map((r) => ({ ...r, format: u16(v, r.offset) }))
      .filter((r) => r.format === 4 || r.format === 12)
      .sort((a, b) => rank(a) - rank(b) || b.format - a.format)
      .map((r) => (r.format === 4 ? CmapFormat.F4(r.offset) : CmapFormat.F12(r.offset)));
  }, bounds('cmap'));
}

/**
 * @param {Uint8Array} b
 * @param {import('../../otel-compact/src/adt.js').Of<typeof CmapFormat>} which
 * @returns {import('../../otel-compact/src/adt.js').Result<(cp: number) => number, any>}
 */
export function cmapLookup(b, which) {
  const v = view(b);
  return guard(() => CmapFormat.match(which, {
    F4: ({ offset: o }) => {
      const segX2 = u16(v, o + 6);
      // Integer, always: an odd segCountX2 made n fractional, the search land one past the arrays,
      // and the glyph offset NaN (fuzz: 'bounds fault outside guard').
      const n = segX2 >>> 1;
      const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      const end = Uint16Array.from({ length: n }, (_, i) => u16(v, ends + i * 2));
      const start = Uint16Array.from({ length: n }, (_, i) => u16(v, starts + i * 2));
      const delta = Int16Array.from({ length: n }, (_, i) => i16(v, deltas + i * 2));
      const range = Uint16Array.from({ length: n }, (_, i) => u16(v, ranges + i * 2));
      return (/** @type {number} */ cp) => {
        if (cp > 0xffff) return 0;
        let lo = 0, hi = n - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (end[m] < cp) lo = m + 1; else hi = m; }
        if (n === 0 || cp < start[lo] || cp > end[lo]) return 0;
        if (range[lo] === 0) return (cp + delta[lo]) & 0xffff;
        // idRangeOffset is relative to its own position in the array.
        const at = ranges + lo * 2 + range[lo] + (cp - start[lo]) * 2;
        if (at + 2 > b.length) return 0;
        const g = u16(v, at);
        return g === 0 ? 0 : (g + delta[lo]) & 0xffff;
      };
    },
    F12: ({ offset: o }) => {
      const n = u32(v, o + 12);
      // The records must be there before anything is sized by n: a lying count is a fault, not a 48 GB allocation.
      if (!fits(v, o + 16, n * 12)) return () => 0;
      const s = new Uint32Array(n), e = new Uint32Array(n), g0 = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        s[i] = u32(v, o + 16 + i * 12); e[i] = u32(v, o + 20 + i * 12); g0[i] = u32(v, o + 24 + i * 12);
      }
      return (/** @type {number} */ cp) => {
        let lo = 0, hi = n - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (e[m] < cp) lo = m + 1; else hi = m; }
        return n > 0 && cp >= s[lo] && cp <= e[lo] ? g0[lo] + (cp - s[lo]) : 0;
      };
    },
  }), bounds('cmap'));
}
