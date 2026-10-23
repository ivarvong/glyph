// @ts-check
// FontFile -> Font: metrics, cmap, advances, and one of two outline sources.

import { variants, ok, err, option, okOr } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { Transform } from '../../woff2/src/woff2.js';
import { indexGlyfV0 } from '../../woff2/src/glyf-transform.js';
import { reconstructHmtx } from '../../woff2/src/hmtx-transform.js';
import { jsBrotli } from '../../woff2/src/brotli.js';
import { openFontFile } from './containers.js';
import { parseHead, parseHhea, parseMaxp, parseHmtx, parseLsb, cmapCandidates, cmapLookup, TableError } from './tables.js';
import { parseGlyfTable, resolvePoints } from './glyf.js';
import { parseCff } from './cff.js';
import { contoursToPath } from '../../outline/src/truetype.js';
import { transform } from '../../outline/src/path.js';

export const OutlineSource = variants('OutlineSource', {
  Glyf: ['glyph'],  // (gid) => Result<Glyph> (quadratic); WOFF2 decodes on first use
  Cff: ['cff'],     // { path(gid) } (cubic)
});

/**
 * @typedef {object} Font
 * @property {string} container
 * @property {number} unitsPerEm
 * @property {number} ascender
 * @property {number} descender
 * @property {number} numGlyphs
 * @property {(cp: number) => number} glyphOf
 * @property {(gid: number) => number} advance
 * @property {import('../../otel-compact/src/adt.js').Of<typeof OutlineSource>} outlines
 * @property {(gid: number, span?: import('../../otel-compact/src/trace.js').Span) => import('../../otel-compact/src/adt.js').Result<import('../../outline/src/path.js').Path, any>} path
 * @property {Map<string, Uint8Array>} tables  raw tables, for the layout engine
 */

/**
 * @param {import('./containers.js').FontFile} file
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @returns {import('../../otel-compact/src/adt.js').Result<Font, any>}
 */
export function buildFont(file, span = NOOP_SPAN) {
  // Errors are values: every step is a Result, and the first Err returns as is.
  const byTag = new Map(file.tables.map((t) => [t.tag, t]));
  /** @param {string} t */
  const table = (t) => okOr(option(byTag.get(t)), TableError.Missing(t));

  const metrics = span.span('font.metrics', () => {
    const h = table('head'); if (h.tag === 'Err') return h;
    const head = parseHead(h.value.data); if (head.tag === 'Err') return head;
    const hh = table('hhea'); if (hh.tag === 'Err') return hh;
    const hhea = parseHhea(hh.value.data); if (hhea.tag === 'Err') return hhea;
    const mx = table('maxp'); if (mx.tag === 'Err') return mx;
    const maxp = parseMaxp(mx.value.data); if (maxp.tag === 'Err') return maxp;
    return ok({ head: head.value, hhea: hhea.value, numGlyphs: maxp.value.numGlyphs });
  });
  if (metrics.tag === 'Err') return metrics;
  const { head, hhea, numGlyphs } = metrics.value;

  const glyphOf = span.span('font.cmap', (cs) => {
    const c = table('cmap'); if (c.tag === 'Err') return c;
    const cands = cmapCandidates(c.value.data); if (cands.tag === 'Err') return cands;
    if (cands.value.length === 0) return err(TableError.NoUnicodeCmap);
    cs.set('format', cands.value[0].tag);
    return cmapLookup(c.value.data, cands.value[0]);
  });
  if (glyphOf.tag === 'Err') return glyphOf;

  /** @type {import('../../otel-compact/src/adt.js').Result<import('../../otel-compact/src/adt.js').Of<typeof OutlineSource>, any>} */
  const outlines = span.span('font.outlines', (s) => {
    if (byTag.has('glyf')) {
      const g = table('glyf'); if (g.tag === 'Err') return g;
      /** @type {import('../../otel-compact/src/adt.js').Result<(gid: number) => import('../../otel-compact/src/adt.js').Result<import('./glyf.js').GlyphT, any>, any>} */
      const accessor = Transform.match(g.value.transform, {
        GlyfV0: () => s.span('glyf.woff2-transform', (gs) => {
          const ix = indexGlyfV0(g.value.data, numGlyphs, gs);
          return ix.tag === 'Err' ? ix : ok(ix.value.glyph);
        }),
        Identity: () => s.span('glyf.raw', () => {
          const l = table('loca'); if (l.tag === 'Err') return l;
          const arr = parseGlyfTable(g.value.data, l.value.data, numGlyphs, head.indexToLocFormat);
          if (arr.tag === 'Err') return arr;
          const glyphs = arr.value;
          return ok((/** @type {number} */ gid) => (gid >= 0 && gid < glyphs.length ? ok(glyphs[gid]) : err(TableError.Invalid('glyf', `glyph ${gid}`))));
        }),
        _: (t) => err(TableError.Invalid('glyf', `transform ${t.tag}`)),
      });
      if (accessor.tag === 'Err') return accessor;
      s.set('format', 'glyf');
      return ok(OutlineSource.Glyf(accessor.value));
    }
    const c = table('CFF '); if (c.tag === 'Err') return c;
    const cff = parseCff(c.value.data); if (cff.tag === 'Err') return cff;
    if (cff.value.numGlyphs !== numGlyphs) return err(TableError.Invalid('CFF ', `${cff.value.numGlyphs} charstrings, maxp says ${numGlyphs}`));
    s.set('format', 'cff');
    return ok(OutlineSource.Cff(cff.value));
  });
  if (outlines.tag === 'Err') return outlines;
  const source = outlines.value;

  // hmtx after outlines: a WOFF2-transformed hmtx omits left side bearings, which are then the
  // glyphs' xMin from glyf (W3C WOFF2 §5.4). The reconstructed table replaces the transformed one.
  const hm = table('hmtx'); if (hm.tag === 'Err') return hm;
  /** @type {import('../../otel-compact/src/adt.js').Result<Uint8Array, any>} */
  const hmtxData = hm.value.transform.tag !== 'HmtxV1' ? ok(hm.value.data) : span.span('hmtx.woff2-transform', () => {
    if (source.tag !== 'Glyf') return err(TableError.Invalid('hmtx', 'transformed hmtx needs glyf for its side bearings'));
    const glyphAt = source.glyph;
    /** @param {number} gid */
    const xMin = (gid) => { const g = glyphAt(gid); return g.tag === 'Ok' && g.value.tag !== 'Empty' ? /** @type {any} */ (g.value).bbox[0] : 0; };
    return reconstructHmtx(hm.value.data, numGlyphs, hhea.numberOfHMetrics, xMin);
  });
  if (hmtxData.tag === 'Err') return hmtxData;
  const advances = span.span('font.hmtx', () => parseHmtx(hmtxData.value, hhea.numberOfHMetrics, numGlyphs));
  if (advances.tag === 'Err') return advances;
  const adv = advances.value;
  // TrueType places an outline so its xMin sits at the hmtx left side bearing: where the two
  // disagree, FreeType and fontTools shift the glyph by lsb − xMin (phantom point pp1), at the
  // top level only. Found by the corpus differential (OpenSansHebrew-Bold, Yellowtail, Armata:
  // whole glyphs 1 unit off). CFF outlines carry their own sidebearing and are not shifted.
  const lsbs = parseLsb(hmtxData.value, hhea.numberOfHMetrics, numGlyphs);
  if (lsbs.tag === 'Err') return lsbs;
  const lsb = lsbs.value;

  /** @type {Map<number, import('../../otel-compact/src/adt.js').Result<import('../../outline/src/path.js').Path, any>>} */
  const memo = new Map();
  /** @param {number} gid @param {import('../../otel-compact/src/trace.js').Span} [ps] */
  const path = (gid, ps = NOOP_SPAN) => {
    const hit = memo.get(gid);
    if (hit) return hit;
    const r = ps.span('glyph.path', { gid }, () => OutlineSource.match(source, {
      Glyf: ({ glyph }) => {
        const p = resolvePoints(glyph, gid);
        if (p.tag === 'Err') return p;
        const path = contoursToPath(p.value);
        const g = glyph(gid);
        const shift = g.tag === 'Ok' && g.value.tag !== 'Empty' ? lsb[gid] - /** @type {any} */ (g.value).bbox[0] : 0;
        return ok(shift ? transform(path, [1, 0, 0, 1, shift, 0]) : path);
      },
      Cff: ({ cff }) => cff.path(gid),
    }));
    memo.set(gid, r);
    return r;
  };

  return ok({
    container: file.container.tag,
    unitsPerEm: head.unitsPerEm,
    ascender: hhea.ascender,
    descender: hhea.descender,
    numGlyphs,
    glyphOf: glyphOf.value,
    advance: (gid) => (gid >= 0 && gid < adv.length ? adv[gid] : 0),
    outlines: source,
    path,
    tables: new Map(file.tables.map((t) => [t.tag, t.tag === 'hmtx' ? hmtxData.value : t.data])),
  });
}

/**
 * bytes -> Font, any container. Ports default to the pure-JS Brotli decoder (every runtime);
 * index.js's loadFont prefers the platform's where it has one.
 * @param {Uint8Array} bytes
 * @param {Partial<import('./containers.js').Ports>} [ports]
 */
export async function loadFont(bytes, ports = {}) {
  const span = ports.span || NOOP_SPAN;
  return span.span('font.load', async (s) => {
    const file = await openFontFile(bytes, { brotli: jsBrotli, ...ports, span: s });
    if (file.tag === 'Err') return file;
    return s.span('font.build', (bs) => buildFont(file.value, bs));
  });
}
