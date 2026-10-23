// Hand-built attacks that random mutation rarely finds: each must end in a typed outcome, fast,
// without large allocations. Dev-only crafting uses node:zlib.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brotliCompressSync, deflateSync, inflateSync } from 'node:zlib';
import { loadFont } from '../../sfnt/src/font.js';
import { jsBrotli, nativeBrotli, portOf } from '../../woff2/src/brotli.js';
import { shape } from '../../shape/src/shape.js';
import { renderText } from '../../render/src/text.js';
import { LIMITS } from '../../sfnt/src/limits.js';
import { decodeTables, packSfnt } from '../mutate.js';
import { target } from '../target.js';
import { regressionFiles, regression } from '../regressions.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';

const FIX = new URL('../../third_party/fonts/', import.meta.url);
const interTables = async () => (await decodeTables(readFileSync(new URL('inter-latin-400.woff', FIX)))).tables.map((t) => ({ tag: t.tag, data: Uint8Array.from(t.data) }));
const withTables = (ts, edits) => packSfnt('true', ts.map((t) => ({ tag: t.tag, data: edits[t.tag] ? edits[t.tag](t.data) : t.data })).sort((a, b) => (a.tag < b.tag ? -1 : 1)));
const inflate = (/** @type {Uint8Array} */ x, /** @type {number} */ m) => portOf((b, max) => new Uint8Array(inflateSync(b, { maxOutputLength: max })))(x, NOOP_SPAN, m);
const load = (b, brotli = jsBrotli) => loadFont(b, { brotli, inflate });
/** Run f and report wall ms and the ArrayBuffer high-water mark it caused (sampled after). */
async function measured(f) {
  const before = process.memoryUsage().arrayBuffers, t = performance.now();
  const value = await f();
  return { value, ms: performance.now() - t, grew: process.memoryUsage().arrayBuffers - before };
}
const base128 = (n) => { const o = []; do { o.unshift(n & 0x7f); n = Math.floor(n / 128); } while (n); return o.map((b, i) => (i < o.length - 1 ? b | 0x80 : b)); };
/** A WOFF2 whose directory declares `declared` bytes for 'head' but whose stream is `comp`. */
function woff2(declared, comp) {
  const dir = [1, ...base128(declared)]; // flags: known tag index 1 = 'head', null transform
  const out = new Uint8Array(48 + dir.length + comp.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x774f4632); dv.setUint32(4, 0x00010000); dv.setUint32(8, out.length); dv.setUint16(12, 1);
  dv.setUint32(16, 12 + 16 + declared); dv.setUint32(20, comp.length);
  out.set(dir, 48); out.set(comp, 48 + dir.length);
  return out;
}

test('Brotli bombs: declared size over the limit is refused unread; a lying small size stops the decoder', async () => {
  const bomb = brotliCompressSync(new Uint8Array(96 << 20)); // 96 MiB of zeros → ~100 bytes
  assert.ok(bomb.length < 1000);
  for (const brotli of [jsBrotli, nativeBrotli]) {
    const big = await measured(() => load(woff2(96 << 20, bomb), brotli));
    assert.equal(big.value.tag, 'Err');
    assert.match(JSON.stringify(big.value.error), /TooLarge/);
    const small = await measured(() => load(woff2(4096, bomb), brotli));
    assert.equal(small.value.tag, 'Err');
    assert.ok(small.ms < 2000, `${brotli.name}: ${small.ms} ms`);
    assert.ok(small.grew < 32 << 20, `${brotli.name}: ArrayBuffers grew ${small.grew}`);
  }
});

test('WOFF 1 zlib bomb: inflation stops at the declared table length', async () => {
  const z = deflateSync(new Uint8Array(32 << 20));
  const out = new Uint8Array(44 + 20 + z.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x774f4646); dv.setUint32(4, 0x00010000); dv.setUint32(8, out.length); dv.setUint16(12, 1);
  [...'head'].forEach((c, i) => { out[44 + i] = c.charCodeAt(0); });
  dv.setUint32(48, 64); dv.setUint32(52, z.length); dv.setUint32(56, 1 << 20); // declares 1 MiB
  out.set(z, 64);
  const r = await measured(() => load(out));
  assert.equal(r.value.tag, 'Err');
  assert.ok(r.grew < 16 << 20, `grew ${r.grew}`);
});

test('cmap format 12 with a 2³¹ group count fails on bounds, not in a giant allocation', async () => {
  const ts = await interTables();
  const cmap = new Uint8Array(12 + 16), v = new DataView(cmap.buffer);
  v.setUint16(2, 1); v.setUint16(4, 3); v.setUint16(6, 10); v.setUint32(8, 12); // one encoding record → offset 12
  v.setUint16(12, 12); v.setUint32(16, 16 + 12); v.setUint32(24, 0x7fffffff); // format 12, nGroups huge
  const r = await measured(() => load(withTables(ts, { cmap: () => cmap })));
  assert.ok(r.ms < 500 && r.grew < 8 << 20, `${r.ms} ms, grew ${r.grew}`);
  if (r.value.tag === 'Ok') assert.equal(r.value.value.glyphOf(65), 0); // or rejected outright: both fine
});

test('composite fan-out (100 children per level, 6 levels, empty leaves) is refused as TooComplex', async () => {
  const ts = await interTables();
  const maxp = ts.find((t) => t.tag === 'maxp').data, numGlyphs = (maxp[4] << 8) | maxp[5];
  const parts = [];
  for (let g = 0; g < 7; g++) {
    if (g === 6) { parts.push(new Uint8Array(0)); continue; }
    const comp = new Uint8Array(10 + 100 * 6), v = new DataView(comp.buffer);
    v.setInt16(0, -1);
    for (let k = 0; k < 100; k++) {
      const o = 10 + k * 6;
      v.setUint16(o, 0x0002 | (k < 99 ? 0x0020 : 0)); // ARGS_ARE_XY_VALUES, MORE_COMPONENTS
      v.setUint16(o + 2, g + 1); comp[o + 4] = 0; comp[o + 5] = 0;
    }
    parts.push(comp);
  }
  const glyf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  const loca = new Uint8Array((numGlyphs + 1) * 4), lv = new DataView(loca.buffer);
  let off = 0;
  for (let g = 0; g <= numGlyphs; g++) { lv.setUint32(g * 4, off); if (g < parts.length) { glyf.set(parts[g], off); off += parts[g].length; } }
  const sfnt = withTables(ts, { glyf: () => glyf, loca: () => loca, head: (h) => { const c = Uint8Array.from(h); c[50] = 0; c[51] = 1; return c; } });
  const f = await load(sfnt);
  assert.equal(f.tag, 'Ok');
  const r = await measured(() => f.value.path(0));
  assert.equal(r.value.tag, 'Err');
  assert.match(JSON.stringify(r.value.error), /TooComplex|TooDeep/);
  assert.ok(r.ms < 500, `${r.ms} ms`);
});

test('GSUB lookup that calls itself: shaping finishes, bounded, with the lookup recorded as skipped work', async () => {
  const ts = await interTables();
  const g = new Uint8Array(76), v = new DataView(g.buffer);
  v.setUint16(0, 1); v.setUint16(4, 10); v.setUint16(6, 30); v.setUint16(8, 44);           // header
  v.setUint16(10, 1); [...'DFLT'].forEach((c, i) => { g[12 + i] = c.charCodeAt(0); }); v.setUint16(16, 8); // ScriptList
  v.setUint16(18, 4); v.setUint16(20, 0);                                                    // Script → LangSys
  v.setUint16(22, 0); v.setUint16(24, 0xffff); v.setUint16(26, 1); v.setUint16(28, 0);       // LangSys: feature 0
  v.setUint16(30, 1); [...'ccmp'].forEach((c, i) => { g[32 + i] = c.charCodeAt(0); }); v.setUint16(36, 8); // FeatureList
  v.setUint16(38, 0); v.setUint16(40, 1); v.setUint16(42, 0);                                // Feature → lookup 0
  v.setUint16(44, 1); v.setUint16(46, 4);                                                    // LookupList → 48
  v.setUint16(48, 5); v.setUint16(50, 0); v.setUint16(52, 1); v.setUint16(54, 8);            // Lookup: type 5 → 56
  v.setUint16(56, 3); v.setUint16(58, 1); v.setUint16(60, 1); v.setUint16(62, 12);           // context format 3
  v.setUint16(64, 0); v.setUint16(66, 0);                                                    // record: seq 0 → lookup 0 (itself)
  v.setUint16(68, 2); v.setUint16(70, 1); v.setUint16(72, 0); v.setUint16(74, 0xffff);       // coverage: every glyph…
  const gsub = new Uint8Array(78); gsub.set(g); new DataView(gsub.buffer).setUint16(76, 0); // …startCoverageIndex 0
  const f = await load(withTables(ts, { GSUB: () => gsub }));
  assert.equal(f.tag, 'Ok');
  const r = await measured(() => shape(f.value, 'recursion '.repeat(100)));
  assert.equal(r.value.tag, 'Ok');
  assert.equal(r.value.value.length, 1000);
  assert.ok(r.ms < 1000, `${r.ms} ms`);
});

test('metrics that would make a gigapixel canvas are refused as CanvasTooLarge', async () => {
  const ts = await interTables();
  const f = await load(withTables(ts, { head: (h) => { const c = Uint8Array.from(h); c[18] = 0; c[19] = 16; return c; } })); // unitsPerEm 16
  assert.equal(f.tag, 'Ok');
  const r = await renderText([{ font: f.value, fontKey: 'x', text: 'Cloudflare', size: 96 }], { targets: [] });
  assert.equal(r.tag, 'Err');
  assert.equal(r.error.tag, 'CanvasTooLarge');
  assert.ok(r.error.width * r.error.height > LIMITS.canvasPixels);
});

test('every saved fuzz finding replays cleanly (Ok | Err, under 2 s)', async () => {
  const files = regressionFiles();
  assert.equal(files.length, 8, 'fuzz/regressions: 1 own input + 7 recipes');
  for (const { name: f, url } of files) {
    const t = performance.now();
    const r = await target(new Uint8Array(readFileSync(url)));
    assert.ok(performance.now() - t < 2000, `${f}: ${(performance.now() - t).toFixed(0)} ms`);
    assert.equal(r.diff, '', `${f}: ${r.diff}`);
    assert.equal(r.contract, '', `${f}: ${r.contract}`);
  }
});

test('hostile metrics: a tiny unitsPerEm makes 24 px text a 20 Mpx canvas; maxPixels turns it into a fast Err', async () => {
  const bytes = regression('slow-tiny-upem-35d6d4188c01.bin');
  const loaded = await load(bytes);
  assert.equal(loaded.tag, 'Ok');
  const spec = [{ font: loaded.value, fontKey: 'f', text: 'Hfiffl AVTo 0123 office "q" —é', size: 24 }];
  const wide = await renderText(spec, { targets: [] });
  assert.equal(wide.tag, 'Ok', 'under the global cap: legal, linear-cost work');
  const t = performance.now();
  const capped = await renderText(spec, { targets: [], maxPixels: 4 << 20 });
  assert.equal(capped.tag, 'Err');
  assert.equal(capped.error.tag, 'CanvasTooLarge');
  assert.equal(capped.error.limit, 4 << 20);
  assert.ok(performance.now() - t < 200, 'rejected before rasterising');
});

test('LangSys fan-out (many ScriptRecords sharing one huge LangSys) parses once per offset, fast', async () => {
  const bytes = regression('slow-langsys-fanout-7066c49e74b9.bin');
  const t = performance.now();
  const r = await target(bytes);
  assert.equal(r.contract, '');
  assert.ok(performance.now() - t < 400, `${(performance.now() - t).toFixed(0)} ms (was ~2000 before memoising LangSys)`);
});
