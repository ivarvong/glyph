// @ts-check
// The OpenType MATH table (OpenType 1.9 §MATH): constants, per-glyph info, and constructions.
// One eager parse into plain data, under the sfnt reader's discipline: every read is total and
// a bad offset is a typed Err, never a throw; counts are 16-bit and coverage expansion is
// bounded, so the parse is O(table) within the read budget. Device tables (hinting deltas per
// ppem) are not applied: values are design units, as HarfBuzz uses them unhinted.

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import { view, u16, i16, guard, times, fits } from '../../sfnt/src/bin.js';

/** @typedef {import('../../sfnt/src/bin.js').View} View */

export const MathError = variants('MathError', {
  Missing: [],              // the font has no MATH table
  Truncated: ['at', 'why'], // a read out of range (or past the read budget)
  Version: ['major'],
  Invalid: ['reason'],
});

/** MathConstants in table order: 4 plain int16/uint16, 51 MathValueRecords, 1 int16. */
export const CONSTANTS = /** @type {const} */ ([
  'ScriptPercentScaleDown', 'ScriptScriptPercentScaleDown', 'DelimitedSubFormulaMinHeight', 'DisplayOperatorMinHeight',
  'MathLeading', 'AxisHeight', 'AccentBaseHeight', 'FlattenedAccentBaseHeight', 'SubscriptShiftDown', 'SubscriptTopMax',
  'SubscriptBaselineDropMin', 'SuperscriptShiftUp', 'SuperscriptShiftUpCramped', 'SuperscriptBottomMin',
  'SuperscriptBaselineDropMax', 'SubSuperscriptGapMin', 'SuperscriptBottomMaxWithSubscript', 'SpaceAfterScript',
  'UpperLimitGapMin', 'UpperLimitBaselineRiseMin', 'LowerLimitGapMin', 'LowerLimitBaselineDropMin', 'StackTopShiftUp',
  'StackTopDisplayStyleShiftUp', 'StackBottomShiftDown', 'StackBottomDisplayStyleShiftDown', 'StackGapMin',
  'StackDisplayStyleGapMin', 'StretchStackTopShiftUp', 'StretchStackBottomShiftDown', 'StretchStackGapAboveMin',
  'StretchStackGapBelowMin', 'FractionNumeratorShiftUp', 'FractionNumeratorDisplayStyleShiftUp',
  'FractionDenominatorShiftDown', 'FractionDenominatorDisplayStyleShiftDown', 'FractionNumeratorGapMin',
  'FractionNumDisplayStyleGapMin', 'FractionRuleThickness', 'FractionDenominatorGapMin',
  'FractionDenomDisplayStyleGapMin', 'SkewedFractionHorizontalGap', 'SkewedFractionVerticalGap', 'OverbarVerticalGap',
  'OverbarRuleThickness', 'OverbarExtraAscender', 'UnderbarVerticalGap', 'UnderbarRuleThickness',
  'UnderbarExtraDescender', 'RadicalVerticalGap', 'RadicalDisplayStyleVerticalGap', 'RadicalRuleThickness',
  'RadicalExtraAscender', 'RadicalKernBeforeDegree', 'RadicalKernAfterDegree', 'RadicalDegreeBottomRaisePercent',
]);
/** @typedef {typeof CONSTANTS[number]} ConstantName */
/** @typedef {Record<ConstantName, number>} Constants */

/** One corner's staircase: kerns[i] applies below heights[i] (and kerns[n] above the last). @typedef {{ heights: number[], kerns: number[] }} MathKern */
/** @typedef {{ TopRight: MathKern | null, TopLeft: MathKern | null, BottomRight: MathKern | null, BottomLeft: MathKern | null }} KernInfo */
/** flags bit 0: an extender (repeatable). @typedef {{ gid: number, start: number, end: number, full: number, flags: number }} Part */
/** @typedef {{ italic: number, parts: Part[] }} Assembly */
/** Size variants, smallest first, then an assembly for anything larger. @typedef {{ variants: { gid: number, advance: number }[], assembly: Assembly | null }} Construction */

/**
 * @typedef {object} MathTable
 * @property {Constants} constants
 * @property {Map<number, number>} italics      gid → italics correction
 * @property {Map<number, number>} topAccent    gid → top accent attachment x
 * @property {Set<number>} extended             extended shapes (their height is not the base height)
 * @property {Map<number, KernInfo>} kerns
 * @property {number} minConnectorOverlap
 * @property {Map<number, Construction>} vertical
 * @property {Map<number, Construction>} horizontal
 */

/**
 * Coverage → glyph ids in coverage-index order, at most `max` of them (the parallel array's
 * count). A format-2 range is expanded only up to that count, so 65535 ranges of 65535 glyphs
 * cost `max` steps, not 4·10⁹.
 * @param {View} v @param {number} o @param {number} max @returns {number[]}
 */
function coverageGids(v, o, max) {
  /** @type {number[]} */
  const out = [];
  const fmt = u16(v, o), n = u16(v, o + 2);
  if (fmt === 1) {
    if (!fits(v, o + 4, n * 2)) return out;
    for (let i = 0; i < n && out.length < max; i++) out.push(u16(v, o + 4 + i * 2));
  } else if (fmt === 2) {
    if (!fits(v, o + 4, n * 6)) return out;
    for (let i = 0; i < n && out.length < max; i++) {
      const r = o + 4 + i * 6, start = u16(v, r), end = u16(v, r + 2), idx = u16(v, r + 4);
      for (let g = start; g <= end && out.length < max; g++) out[idx + g - start] = g;
      if (out.length > max) out.length = max;
    }
    // Ranges must tile the indices 0..n-1; a gap would leave a hole (an array without a value).
    for (let i = 0; i < out.length; i++) if (typeof out[i] !== 'number') out[i] = -1;
  }
  return out;
}

/** MathValueRecord: int16 value + Offset16 device table (ignored). @param {View} v @param {number} o */
const value = (v, o) => i16(v, o);

/**
 * gid → value over a coverage and a parallel array of MathValueRecords at `rec`.
 * @param {View} v @param {number} covAt @param {number} count @param {number} rec
 */
function valueMap(v, covAt, count, rec) {
  /** @type {Map<number, number>} */
  const m = new Map();
  if (!fits(v, rec, count * 4)) return m;
  const gids = coverageGids(v, covAt, count);
  gids.forEach((g, i) => { if (g >= 0) m.set(g, value(v, rec + i * 4)); });
  return m;
}

/** @param {View} v @param {number} o @returns {MathKern} */
function mathKern(v, o) {
  const n = u16(v, o);
  if (!fits(v, o + 2, (2 * n + 1) * 4)) return { heights: [], kerns: [] };
  return {
    heights: times(n, (i) => value(v, o + 2 + i * 4)),
    kerns: times(n + 1, (i) => value(v, o + 2 + (n + i) * 4)),
  };
}

/** @param {View} v @param {number} o @returns {Construction} */
function construction(v, o) {
  const asmOff = u16(v, o), n = u16(v, o + 2);
  const variants = fits(v, o + 4, n * 4) ? times(n, (i) => ({ gid: u16(v, o + 4 + i * 4), advance: u16(v, o + 6 + i * 4) })) : [];
  /** @type {Assembly | null} */
  let assembly = null;
  if (asmOff) {
    const a = o + asmOff, parts = u16(v, a + 4);
    assembly = {
      italic: value(v, a),
      parts: fits(v, a + 6, parts * 10) ? times(parts, (i) => {
        const p = a + 6 + i * 10;
        return { gid: u16(v, p), start: u16(v, p + 2), end: u16(v, p + 4), full: u16(v, p + 6), flags: u16(v, p + 8) };
      }) : [],
    };
  }
  return { variants, assembly };
}

/**
 * MATH table bytes → MathTable.
 * @param {Uint8Array} bytes
 * @returns {import('../../otel-compact/src/adt.js').Result<MathTable, import('../../otel-compact/src/adt.js').Of<typeof MathError>>}
 */
export function parseMath(bytes) {
  const v = view(bytes);
  const r = guard(() => {
    const major = u16(v, 0);
    if (major !== 1) return MathError.Version(major);
    const cOff = u16(v, 4), giOff = u16(v, 6), mvOff = u16(v, 8);
    if (!cOff || !giOff || !mvOff) return MathError.Invalid('null MathConstants, MathGlyphInfo or MathVariants offset');

    // MathConstants.
    const constants = /** @type {Constants} */ ({});
    CONSTANTS.forEach((name, i) => {
      constants[name] = i < 4 ? (i < 2 ? i16(v, cOff + i * 2) : u16(v, cOff + i * 2))
        : i < 55 ? value(v, cOff + 8 + (i - 4) * 4) : i16(v, cOff + 8 + 51 * 4);
    });

    // MathGlyphInfo: four optional subtables.
    const itOff = u16(v, giOff), taOff = u16(v, giOff + 2), exOff = u16(v, giOff + 4), kiOff = u16(v, giOff + 6);
    const italics = itOff ? valueMap(v, giOff + itOff + u16(v, giOff + itOff), u16(v, giOff + itOff + 2), giOff + itOff + 4) : new Map();
    const topAccent = taOff ? valueMap(v, giOff + taOff + u16(v, giOff + taOff), u16(v, giOff + taOff + 2), giOff + taOff + 4) : new Map();
    const extended = new Set(exOff ? coverageGids(v, giOff + exOff, 65536) : []);
    extended.delete(-1);
    /** @type {Map<number, KernInfo>} */
    const kerns = new Map();
    if (kiOff) {
      const k = giOff + kiOff, n = u16(v, k + 2);
      if (fits(v, k + 4, n * 8)) {
        coverageGids(v, k + u16(v, k), n).forEach((g, i) => {
          if (g < 0) return;
          const rec = k + 4 + i * 8;
          const corner = (/** @type {number} */ j) => { const off = u16(v, rec + j * 2); return off ? mathKern(v, k + off) : null; };
          kerns.set(g, { TopRight: corner(0), TopLeft: corner(1), BottomRight: corner(2), BottomLeft: corner(3) });
        });
      }
    }

    // MathVariants.
    const minConnectorOverlap = u16(v, mvOff);
    const vCov = u16(v, mvOff + 2), hCov = u16(v, mvOff + 4), nV = u16(v, mvOff + 6), nH = u16(v, mvOff + 8);
    /** @param {number} covOff @param {number} n @param {number} first */
    const cons = (covOff, n, first) => {
      /** @type {Map<number, Construction>} */
      const m = new Map();
      if (!covOff || !fits(v, mvOff + first, n * 2)) return m;
      coverageGids(v, mvOff + covOff, n).forEach((g, i) => {
        const off = u16(v, mvOff + first + i * 2);
        if (g >= 0 && off) m.set(g, construction(v, mvOff + off));
      });
      return m;
    };
    const vertical = cons(vCov, nV, 10), horizontal = cons(hCov, nH, 10 + nV * 2);
    return { tag: /** @type {const} */ ('Table'), table: { constants, italics, topAccent, extended, kerns, minConnectorOverlap, vertical, horizontal } };
  }, (f) => MathError.Truncated(f.at, f.why));
  if (r.tag === 'Err') return r;
  const v2 = r.value;
  return 'table' in v2 ? ok(v2.table) : err(/** @type {import('../../otel-compact/src/adt.js').Of<typeof MathError>} */ (v2));
}

/**
 * The MATH table of a loaded font.
 * @param {import('../../sfnt/src/font.js').Font} font
 */
export function mathOf(font) {
  const b = font.tables.get('MATH');
  return b ? parseMath(b) : err(MathError.Missing);
}
