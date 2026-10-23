// The fuzz target: everything a request with a user-supplied font would run.
// Contract under test: for ANY bytes, every stage returns (Ok or a typed Err) within the time and
// memory budgets. A throw, a hang, or a budget overrun is a finding.
// Oracles beyond "no throw":
//   diff      our Brotli decoder must agree with node:zlib's
//   contract  no `undefined` anywhere in a returned value (Err payloads, paths, shaped glyphs,
//             scenes); and no bounds fault recorded outside a guard() scope (bin.js rootFaults)
import { brotliDecompressSync } from 'node:zlib';
import { loadFont } from '../sfnt/src/font.js';
import { jsBrotli, portOf } from '../woff2/src/brotli.js';
import { brotliDecode } from '../woff2/src/brotli-js.js';
import { readContainer } from '../woff2/src/woff2.js';
import { inflateSync } from 'node:zlib';
import { renderText } from '../render/src/text.js';
import { scanline, flattenCache, scenePolygons } from '../render/src/raster.js';
import { fastZlib } from '../render/src/png.js';
import { pngChunks } from '../render/src/stream.js';
import { toSvg } from '../render/src/svg.js';
import { NOOP_SPAN } from '../otel-compact/src/trace.js';
import { rootFaults } from '../sfnt/src/bin.js';
import { shape } from '../shape/src/shape.js';
import { parseMath } from '../math/src/table.js';

/**
 * Path to the first `undefined` inside v ('' if none). Walks plain objects and arrays; skips
 * typed arrays and functions; bounded so a huge value costs at most `budget` visits.
 * @param {unknown} v @param {string} at @returns {string}
 */
export function findUndefined(v, at = '$', budget = { n: 20000 }, seen = new Set()) {
  if (v === undefined) return at;
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v) || seen.has(v) || --budget.n < 0) return '';
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const p = findUndefined(v[i], `${at}[${i}]`, budget, seen); if (p) return p; }
    return '';
  }
  if (v instanceof Map) { for (const [k, x] of v) { const p = findUndefined(x, `${at}.get(${k})`, budget, seen); if (p) return p; } return ''; }
  for (const k of Object.keys(v)) { const p = findUndefined(/** @type {any} */ (v)[k], `${at}.${k}`, budget, seen); if (p) return p; }
  return '';
}

const TEXT = 'Hfiffl AVTo 0123 office "q" —é';

/** @param {Uint8Array} bytes @returns {Promise<{ reached: string, diff: string, contract: string }>} */
export async function target(bytes) {
  const faults0 = rootFaults();
  let contract = ''; // '' = no violation; else the first one
  const noUndef = (/** @type {string} */ where, /** @type {unknown} */ v) => {
    if (contract) return;
    const p = findUndefined(v);
    if (p) contract = `undefined in ${where} at ${p.replace(/\[\d+\]/g, '[N]')}`;
  };
  const result = (/** @type {string} */ reached) => {
    if (!contract && rootFaults() !== faults0) contract = `bounds fault outside guard() reaching ${reached.split(':')[0]}`;
    return { reached, diff, contract };
  };
  // Differential: Brotli stream of a parseable WOFF2 container.
  let diff = ''; // '' = no disagreement
  const c = readContainer(bytes);
  if (c.tag === 'Ok') {
    const ours = brotliDecode(c.value.compressed, { maxOutput: 64 << 20 });
    if (ours.tag === 'Err') noUndef('brotli Err', ours.error);
    let theirs = null;
    try { theirs = brotliDecompressSync(c.value.compressed, { maxOutputLength: 64 << 20 }); } catch { theirs = null; }
    // We reject bytes after the final meta-block; node:zlib ignores them. Stricter is fine.
    if (theirs && ours.tag === 'Err' && ours.error.tag === 'TrailingBits') { /* accepted divergence */ }
    else if (theirs && ours.tag === 'Err') diff = `brotli: node decodes ${theirs.length} B, ours errs ${JSON.stringify(ours.error)}`;
    else if (theirs && ours.tag === 'Ok' && Buffer.compare(Buffer.from(ours.value), theirs) !== 0) diff = 'brotli: outputs differ';
    else if (!theirs && ours.tag === 'Ok') diff = `brotli: node rejects, ours accepts ${ours.value.length} B`;
  }
  const f = await loadFont(bytes, { brotli: jsBrotli, inflate: (b, m) => portOf((x, max) => new Uint8Array(inflateSync(x, { maxOutputLength: max })))(b, NOOP_SPAN, m) });
  if (c.tag === 'Err') noUndef('container Err', c.error);
  if (f.tag === 'Err') { noUndef('load Err', f.error); return result(`load:${f.error.tag}`); }
  const font = f.value;
  // Every glyph the file claims (bounded), through the outline path and flattening.
  const n = Math.min(font.numGlyphs, 96);
  for (let g = 0; g < n; g++) {
    const p = font.path(g);
    noUndef(p.tag === 'Ok' ? 'path' : 'path Err', p.tag === 'Ok' ? p.value : p.error);
    if (p.tag === 'Ok' && p.value.length) {
      scenePolygons({ width: 64, height: 64, background: [0, 0, 0, 0], items: [{ path: p.value, key: `g${g}`, transform: [24 / font.unitsPerEm, 0, 0, -24 / font.unitsPerEm, 8, 48], fill: [0, 0, 0, 255] }] }, NOOP_SPAN, flattenCache({ maxBytes: 1 << 20 }));
    }
  }
  // The MATH table, when there is one (math layout reads it eagerly).
  const mt = font.tables.get('MATH');
  if (mt) { const m = parseMath(mt); noUndef(m.tag === 'Ok' ? 'MATH' : 'MATH Err', m.tag === 'Ok' ? m.value : m.error); }
  // Shape + layout + both outputs, at a modest size.
  const sh = shape(font, TEXT);
  noUndef(sh.tag === 'Ok' ? 'shape' : 'shape Err', sh.tag === 'Ok' ? sh.value : sh.error);
  const r = await renderText([{ font, fontKey: 'f', text: TEXT, size: 24 }], { targets: [] });
  if (r.tag === 'Err') { noUndef('render Err', r.error); return result(`render:${r.error.tag}`); }
  noUndef('scene', r.value.scene);
  toSvg(r.value.scene);
  for await (const _ of pngChunks(r.value.scene, scanline, fastZlib, { rows: 64 })) { /* drain */ }
  return result('png');
}
