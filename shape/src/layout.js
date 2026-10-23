// @ts-check
// OpenType Layout common structures (GSUB/GPOS/GDEF) parsed into plain data.
// Everything here is a pure function of the table bytes.

import { variants, ok } from '../../otel-compact/src/adt.js';
import { view, u16, i16, u32, tag, guard, slice, times, fits } from '../../sfnt/src/bin.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';

/** @typedef {import('../../sfnt/src/bin.js').View} View */

export const LayoutError = variants('LayoutError', { Truncated: ['table', 'at'] });

/** Coverage -> Map(gid -> coverage index). @param {View} v @param {number} o */
export function coverage(v, o) {
  /** @type {Map<number, number>} */
  const m = new Map();
  const fmt = u16(v, o);
  if (fmt === 1) {
    const n = u16(v, o + 2);
    for (let i = 0; i < n; i++) m.set(u16(v, o + 4 + i * 2), i);
  } else if (fmt === 2) {
    const n = u16(v, o + 2);
    for (let i = 0; i < n; i++) {
      const r = o + 4 + i * 6;
      const start = u16(v, r), end = u16(v, r + 2), idx = u16(v, r + 4);
      for (let g = start; g <= end; g++) m.set(g, idx + g - start);
    }
  }
  return m;
}

/**
 * Coverage without parsing: binary search over the table in place (as HarfBuzz does).
 * `get(g)` is the coverage index, or -1 when g is not covered: a number sentinel on the hottest
 * path in shaping, so no allocation per probe and no undefined. The arrays are taken as one
 * exact-length slice first: if the table is short, the slice is empty (and the fault recorded in
 * the active guard), so the view covers nothing instead of reading past the end.
 * @param {View} v @param {number} o
 * @returns {{ get(g: number): number, has(g: number): boolean }}
 */
export function coverageView(v, o) {
  const fmt = u16(v, o), n = u16(v, o + 2);
  const s = slice(v, o + 4, n * (fmt === 1 ? 2 : 6));
  const dv = s.dv, len = s.bytes.length === 0 ? 0 : n;
  const get = fmt === 1
    ? (/** @type {number} */ g) => {
      let lo = 0, hi = len - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1, x = dv.getUint16(m * 2); if (x === g) return m; if (x < g) lo = m + 1; else hi = m - 1; }
      return -1;
    }
    : fmt === 2
      ? (/** @type {number} */ g) => {
        let lo = 0, hi = len - 1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1, r = m * 6;
          const start = dv.getUint16(r), end = dv.getUint16(r + 2);
          if (g < start) hi = m - 1; else if (g > end) lo = m + 1; else return dv.getUint16(r + 4) + g - start;
        }
        return -1;
      }
      : () => -1;
  return { get, has: (g) => get(g) >= 0 };
}

/** ClassDef without parsing: index (format 1) or binary search (format 2) in place, over an exact-length slice. @param {View} v @param {number} o */
export function classView(v, o) {
  const fmt = u16(v, o);
  if (fmt === 1) {
    const start = u16(v, o + 2), n = u16(v, o + 4);
    const s = slice(v, o + 6, n * 2), dv = s.dv, len = s.bytes.length === 0 ? 0 : n;
    return (/** @type {number} */ g) => (g >= start && g < start + len ? dv.getUint16((g - start) * 2) : 0);
  }
  if (fmt === 2) {
    const n = u16(v, o + 2);
    const s = slice(v, o + 4, n * 6), dv = s.dv, len = s.bytes.length === 0 ? 0 : n;
    return (/** @type {number} */ g) => {
      let lo = 0, hi = len - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1, r = m * 6;
        const start = dv.getUint16(r), end = dv.getUint16(r + 2);
        if (g < start) hi = m - 1; else if (g > end) lo = m + 1; else return dv.getUint16(r + 4);
      }
      return 0;
    };
  }
  return () => 0;
}

/** ClassDef -> (gid) => class (default 0). @param {View} v @param {number} o */
export function classDef(v, o) {
  /** @type {Map<number, number>} */
  const m = new Map();
  const fmt = u16(v, o);
  if (fmt === 1) {
    const start = u16(v, o + 2), n = u16(v, o + 4);
    for (let i = 0; i < n; i++) m.set(start + i, u16(v, o + 6 + i * 2));
  } else if (fmt === 2) {
    const n = u16(v, o + 2);
    for (let i = 0; i < n; i++) {
      const r = o + 4 + i * 6;
      const start = u16(v, r), end = u16(v, r + 2), cls = u16(v, r + 4);
      for (let g = start; g <= end; g++) m.set(g, cls);
    }
  }
  return (/** @type {number} */ g) => m.get(g) ?? 0;
}

/**
 * @typedef {object} Gdef
 * @property {(g: number) => number} glyphClass  1 base, 2 ligature, 3 mark, 4 component, 0 unset
 * @property {boolean} hasClasses  GDEF has a GlyphClassDef (else classes are synthesised from Unicode)
 * @property {(g: number) => number} markAttachClass
 * @property {Map<number, number>[]} markSets
 */

/** @type {Gdef} */
export const EMPTY_GDEF = Object.freeze({ glyphClass: () => 0, markAttachClass: () => 0, markSets: [], hasClasses: false });

/** @param {Uint8Array} b @returns {import('../../otel-compact/src/adt.js').Result<Gdef, any>} */
export function parseGdef(b) {
  const v = view(b);
  return guard(() => {
    const minor = u16(v, 2);
    const gc = u16(v, 4), mac = u16(v, 10);
    const ms = minor >= 2 ? u16(v, 12) : 0;
    const markSets = ms ? times(u16(v, ms + 2), (i) => coverage(v, ms + u32(v, ms + 4 + i * 4))) : [];
    return {
      glyphClass: gc ? classDef(v, gc) : () => 0,
      hasClasses: gc !== 0,
      markAttachClass: mac ? classDef(v, mac) : () => 0,
      markSets,
    };
  }, (e) => LayoutError.Truncated('GDEF', e.at));
}

/**
 * @typedef {object} Lookup
 * @property {number} index
 * @property {number} type        after unwrapping Extension
 * @property {number} flag
 * @property {number} markSet     -1 unless UseMarkFilteringSet
 * @property {number[]} subtables  absolute offsets into the table
 */

/**
 * @typedef {object} LayoutTable
 * @property {View} v
 * @property {Map<string, { defaultLang: number[] }>} scripts  feature indices of each script's default LangSys
 * @property {{ tag: string, lookups: number[] }[]} features
 * @property {Lookup[]} lookups
 */

/**
 * FeatureVariations (GSUB/GPOS 1.1) at the default instance: every axis at its default, i.e.
 * normalised coordinate 0. A record matches when each of its conditions' [min, max] contains 0
 * (an empty condition set always matches); the first match substitutes its alternate feature
 * tables. Variable fonts use this for default-instance glyph swaps that HarfBuzz applies
 * (corpus differential: HeptaSlab's comma.BRACKET.24, NotoSansLaoLooped's space.BRACKET.varAlt01).
 * Unknown condition formats do not match, as in HarfBuzz.
 * @param {View} v @param {{ tag: string, lookups: number[] }[]} features
 */
function applyFeatureVariations(v, features) {
  if (u16(v, 0) !== 1 || u16(v, 2) < 1) return;
  const fvo = u32(v, 10);
  if (!fvo) return;
  const n = u32(v, fvo + 4);
  if (!fits(v, fvo + 8, n * 8)) return;
  for (let r = 0; r < n; r++) {
    const cs = u32(v, fvo + 8 + r * 8), fts = u32(v, fvo + 12 + r * 8);
    let match = true;
    if (cs) {
      const nc = u16(v, fvo + cs);
      for (let c = 0; c < nc && match; c++) {
        const co = fvo + cs + u32(v, fvo + cs + 2 + c * 4);
        match = u16(v, co) === 1 && i16(v, co + 4) <= 0 && 0 <= i16(v, co + 6); // F2Dot14 min ≤ 0 ≤ max
      }
    }
    if (!match) continue;
    if (fts) {
      const base = fvo + fts, count = u16(v, base + 4);
      for (let k = 0; k < count; k++) {
        const fi = u16(v, base + 6 + k * 6), alt = base + u32(v, base + 8 + k * 6);
        if (fi < features.length) features[fi] = { tag: features[fi].tag, lookups: times(u16(v, alt + 2), (j) => u16(v, alt + 4 + j * 2)) };
      }
    }
    return; // first matching record only
  }
}

/**
 * GSUB or GPOS header, script/feature/lookup lists. Extension subtables are
 * resolved here so appliers never see type 7 (GSUB) / 9 (GPOS).
 * @param {Uint8Array} b
 * @param {'GSUB' | 'GPOS'} which
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @returns {import('../../otel-compact/src/adt.js').Result<LayoutTable, any>}
 */
export function parseLayout(b, which, span = NOOP_SPAN) {
  const v = view(b);
  const extType = which === 'GSUB' ? 7 : 9;
  return guard(() => {
    const sl = u16(v, 4), fl = u16(v, 6), ll = u16(v, 8);
    /** @type {Map<string, { defaultLang: number[] }>} */
    const scripts = new Map();
    span.span('layout.scripts', { atomic: true, items: u16(v, sl) }, () => {
    // Each LangSys is parsed once per offset: a hostile table can point 65535 ScriptRecords at one
    // 65535-feature LangSys (4·10⁹ in-range reads; fuzz: 'slow … render:Truncated'). Shared
    // offsets share the parsed array; `times` stops at the first fault.
    /** @type {Map<number, number[]>} */
    const langSys = new Map();
    /** @param {number} at @returns {number[]} */
    const parseLangSys = (at) => {
      const known = langSys.get(at);
      if (known) return known;
      const req = u16(v, at + 2);
      const list = times(u16(v, at + 4), (k) => u16(v, at + 6 + k * 2));
      const parsed = req === 0xffff ? list : [req, ...list];
      langSys.set(at, parsed);
      return parsed;
    };
    times(u16(v, sl), (i) => {
      const s = sl + u16(v, sl + 6 + i * 6); // ScriptRecord: tag[4], offset16
      const dl = u16(v, s);
      scripts.set(tag(v, sl + 2 + i * 6), { defaultLang: dl ? parseLangSys(s + dl) : [] });
    });
    });
    const features = span.span('layout.features', { atomic: true, items: u16(v, fl) }, () => times(u16(v, fl), (i) => {
      const f = fl + u16(v, fl + 6 + i * 6);
      return { tag: tag(v, fl + 2 + i * 6), lookups: times(u16(v, f + 2), (k) => u16(v, f + 4 + k * 2)) };
    }));
    span.span('layout.featureVariations', () => applyFeatureVariations(v, features));
    const lookups = span.span('layout.lookups', { atomic: true, items: u16(v, ll) }, () => times(u16(v, ll), (index) => {
      const l = ll + u16(v, ll + 2 + index * 2);
      let type = u16(v, l);
      const flag = u16(v, l + 2);
      const n = u16(v, l + 4);
      let subtables = times(n, (k) => l + u16(v, l + 6 + k * 2));
      if (type === extType && n > 0) {
        type = u16(v, subtables[0] + 2);
        subtables = subtables.map((s) => s + u32(v, s + 4));
      }
      const markSet = flag & 0x10 ? u16(v, l + 6 + n * 2) : -1;
      return { index, type, flag, markSet, subtables };
    }));
    return { v, scripts, features, lookups };
  }, (e) => LayoutError.Truncated(which, e.at));
}

/**
 * Lookup indices to apply, in lookup-list order, for the given script and features.
 * @param {LayoutTable} t
 * @param {string[]} scriptPrefs
 * @param {ReadonlySet<string>} enabled
 */
export function selectLookups(t, scriptPrefs, enabled) {
  const script = scriptPrefs.map((s) => t.scripts.get(s)).find(Boolean);
  if (!script) return { lookups: /** @type {Lookup[]} */ ([]), features: /** @type {string[]} */ ([]) };
  const feats = script.defaultLang.map((i) => t.features[i]).filter((f) => f && enabled.has(f.tag));
  const idx = [...new Set(feats.flatMap((f) => f.lookups))].sort((a, b) => a - b);
  return { lookups: idx.map((i) => t.lookups[i]).filter(Boolean), features: [...new Set(feats.map((f) => f.tag))] };
}

export { ok };
