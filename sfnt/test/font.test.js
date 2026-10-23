import { portOf } from '../../woff2/src/brotli.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allFonts, readJson, read } from './fixtures.js';
import { canonical, outlineDistance } from './canon.js';
import { Glyph } from '../src/glyf.js';
import { cmapCandidates, cmapLookup } from '../src/tables.js';
import { runCharstring } from '../src/cff.js';
import { decodeGlyfV0 } from '../../woff2/src/glyf-transform.js';
import { parseComponents } from '../src/glyf.js';
import { view } from '../src/bin.js';

const REFS = { inter: readJson('third_party/ref/fonttools-inter.json'), sourceSerif: readJson('third_party/ref/fonttools-sourceSerif.json') };

test('fixture matrix covers 2 fonts × 2 containers × both outline formats', async () => {
  const fonts = await allFonts();
  assert.deepEqual(fonts.map((f) => `${f.key}:${f.font.container}:${f.font.outlines.tag}`).sort(), [
    'inter:Woff2:Glyf', 'inter:Woff:Glyf', 'sourceSerif:Sfnt:Cff', 'sourceSerif:Woff2:Cff',
  ].sort());
});

test('metrics, cmap and advances equal fontTools for every file', async () => {
  for (const { key, file, font } of await allFonts()) {
    const ref = REFS[key];
    assert.equal(font.numGlyphs, ref.numGlyphs, file);
    assert.equal(font.unitsPerEm, ref.unitsPerEm, file);
    assert.equal(font.ascender, ref.ascender, file);
    assert.equal(font.descender, ref.descender, file);
    for (const [cp, gid] of Object.entries(ref.cmap)) assert.equal(font.glyphOf(Number(cp)), gid, `${file} U+${Number(cp).toString(16)}`);
    assert.equal(font.glyphOf(0x10ffff), 0);
    for (let g = 0; g < ref.numGlyphs; g++) assert.equal(font.advance(g), ref.advances[g], `${file} advance ${g}`);
  }
});

test('cmap formats 4 and 12 agree on every BMP codepoint (Source Serif has both)', () => {
  const cmap = (() => {
    // Pull the raw cmap table out of the sfnt directory.
    const b = read('third_party/fonts/source-serif-4-regular.otf');
    const dv = new DataView(b.buffer, b.byteOffset);
    for (let i = 0; i < dv.getUint16(4); i++) {
      const r = 12 + i * 16;
      if (String.fromCharCode(...b.subarray(r, r + 4)) === 'cmap') return b.subarray(dv.getUint32(r + 8), dv.getUint32(r + 8) + dv.getUint32(r + 12));
    }
  })();
  const cands = cmapCandidates(cmap).value;
  const f12 = cmapLookup(cmap, cands.find((c) => c.tag === 'F12')).value;
  const f4 = cmapLookup(cmap, cands.find((c) => c.tag === 'F4')).value;
  let mapped = 0;
  for (let cp = 0; cp <= 0xffff; cp++) {
    assert.equal(f4(cp), f12(cp), `U+${cp.toString(16)}`);
    if (f4(cp)) mapped++;
  }
  assert.ok(mapped > 500, `only ${mapped} mapped`);
});

test('every outline equals fontTools exactly, for every glyph in every file', async () => {
  for (const { key, file, font } of await allFonts()) {
    const ref = REFS[key];
    let segs = 0;
    for (let g = 0; g < font.numGlyphs; g++) {
      const p = font.path(g);
      assert.equal(p.tag, 'Ok', `${file} glyph ${g}: ${JSON.stringify(p.error)}`);
      const ours = canonical(p.value);
      const d = outlineDistance(ours, ref.outlines[g]);
      assert.ok(d === 0, `${file} glyph ${g}: distance ${d}\n ours ${JSON.stringify(ours).slice(0, 300)}\n ref  ${JSON.stringify(ref.outlines[g]).slice(0, 300)}`);
      segs += ours.reduce((n, c) => n + c.length, 0);
    }
    assert.ok(segs > 10000, `${file}: ${segs} segments compared`);
  }
});

test('glyf records: WOFF2 transform decoder == raw glyf parser == fontTools', async () => {
  const fonts = (await allFonts()).filter((f) => f.key === 'inter');
  const [a, b] = fonts.map((f) => f.font.outlines.glyph);
  const ref = REFS.inter.glyf;
  for (let g = 0; g < ref.length; g++) {
    const r = ref[g];
    for (const glyph of [a, b]) {
      const got = glyph(g);
      assert.equal(got.tag, 'Ok', `glyph ${g}`);
      const x = got.value;
      assert.equal(x.tag, r.kind, `glyph ${g}`);
      Glyph.match(x, {
        Empty: () => {},
        Simple: (s) => {
          assert.deepEqual(s.bbox, r.bbox, `bbox ${g}`);
          assert.deepEqual([...s.endPts], r.endPts, `endPts ${g}`);
          assert.deepEqual([...s.xs].map((v, i) => [v, s.ys[i]]), r.coords, `coords ${g}`);
          assert.deepEqual([...s.on], r.on, `on ${g}`);
          assert.equal(s.instructions, r.instructions, `instructions ${g}`);
        },
        Composite: (c) => {
          assert.deepEqual(c.bbox, r.bbox, `bbox ${g}`);
          // fontTools keeps only semantic flag bits; structural ones (words, XY, scale kind, more) it re-derives on save.
          const SEMANTIC = 0x0004 | 0x0200 | 0x0400 | 0x0800 | 0x1000;
          assert.deepEqual(c.components.map((k) => [k.glyph, k.flags & SEMANTIC, k.offset.tag, k.offset.dx, k.offset.dy]),
            r.components.map((k) => [k.glyph, k.flags & SEMANTIC, k.x === null ? 'Anchor' : 'XY', k.x, k.y]), `components ${g}`);
        },
      });
    }
  }
});

// ---- Paths neither fixture exercises: synthetic inputs, hand-computed expectations.

test('composite matrices: scale, x/y scale, 2×2, scaled offset (synthetic records)', () => {
  // flags | glyph | args (bytes) | transform
  const rec = (flags, glyph, args, tf) => [flags >> 8, flags & 255, glyph >> 8, glyph & 255, ...args, ...tf];
  const f2 = (x) => { const v = Math.round(x * 16384) & 0xffff; return [v >> 8, v & 255]; };
  const bytes = new Uint8Array([
    ...rec(0x0002 | 0x0008 | 0x0020, 1, [10, 0xf6], f2(0.5)),                       // XY, scale 0.5, more
    ...rec(0x0002 | 0x0040 | 0x0020, 2, [0, 0], [...f2(1.5), ...f2(-1)]),           // x/y scale (F2Dot14 range is [-2, 2)), more
    ...rec(0x0001 | 0x0002 | 0x0080 | 0x0800 | 0x0020, 3, [0, 100, 0xff, 0x9c], [...f2(0), ...f2(1), ...f2(-1), ...f2(0)]), // words, 2×2 rotate, scaled offset
    ...rec(0x0000, 4, [7, 9], []),                                                  // anchor (point indices)
  ]);
  const { components, end } = parseComponents(view(bytes), 0);
  assert.equal(end, bytes.length);
  assert.deepEqual(components.map((c) => c.matrix), [[0.5, 0, 0, 0.5], [1.5, 0, 0, -1], [0, 1, -1, 0], [1, 0, 0, 1]]);
  assert.deepEqual(components.map((c) => [c.offset.tag, c.offset.dx ?? c.offset.parent, c.offset.dy ?? c.offset.child]),
    [['XY', 10, -10], ['XY', 0, 0], ['XY', 100, -100], ['Anchor', 7, 9]]);
});

test('flex operators (unused by Source Serif): hflex, flex1, flex', () => {
  const n = (v) => [v + 139]; // -107..107 single-byte operands
  const run = (...code) => runCharstring(new Uint8Array(code), [], [], 0).value;
  // hflex: dx1 dx2 dy2 dx3 dx4 dx5 dx6 -> two curves, second returns to start y
  const h = run(...n(0), ...n(0), 21, ...n(10), ...n(10), ...n(5), ...n(10), ...n(10), ...n(10), ...n(10), 12, 34, 14);
  assert.deepEqual(h.map((s) => s.tag), ['MoveTo', 'CubicTo', 'CubicTo', 'Close']);
  assert.deepEqual([h[2].x, h[2].y], [60, 0]);
  // flex1 with |dx| > |dy|: last point returns to the starting y
  const f1 = run(...n(0), ...n(0), 21, ...n(10), ...n(1), ...n(10), ...n(1), ...n(10), ...n(1), ...n(10), ...n(-1), ...n(10), ...n(-1), ...n(10), 12, 37, 14);
  assert.equal(f1[2].y, 0);
  assert.equal(f1[2].x, 60);
  // flex: 12 args + depth
  const f = run(...n(0), ...n(0), 21, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap(n), ...n(50), 12, 35, 14);
  assert.deepEqual([f[2].x, f[2].y], [1 + 3 + 5 + 7 + 9 + 11, 2 + 4 + 6 + 8 + 10 + 12]);
});

test('indexed (lazy) WOFF2 glyf decoder == eager decoder, every glyph, any access order', async () => {
  const { decodeWoff2 } = await import('../../woff2/src/woff2.js');
  const { indexGlyfV0 } = await import('../../woff2/src/glyf-transform.js');
  const { brotliDecompressSync } = await import('node:zlib');
  const d = await decodeWoff2(read('third_party/fonts/inter-latin-400.woff2'), { decompress: portOf((b) => new Uint8Array(brotliDecompressSync(b))) });
  const glyf = d.value.tables.find((t) => t.tag === 'glyf').data;
  const eager = decodeGlyfV0(glyf, 518).value.glyphs;
  const lazy = indexGlyfV0(glyf, 518).value;
  // Reverse and strided orders: decoding must not depend on what was decoded before.
  const order = [...Array(518).keys()].reverse().filter((g) => g % 3 === 0).concat([...Array(518).keys()]);
  for (const g of order) assert.deepEqual(lazy.glyph(g), { tag: 'Ok', value: eager[g] }, `glyph ${g}`);
  for (let cut = 0; cut < glyf.length; cut += 211) assert.equal(indexGlyfV0(glyf.subarray(0, cut), 518).tag, 'Err', `cut ${cut}`);
});

test('WOFF2 glyf transform: every truncation is a typed error, never a throw', async () => {
  const fonts = (await allFonts()).filter((f) => f.key === 'inter' && f.font.container === 'Woff2');
  // Rebuild the raw transformed table from the container to mutate it.
  const { decodeWoff2 } = await import('../../woff2/src/woff2.js');
  const { brotliDecompressSync } = await import('node:zlib');
  const d = await decodeWoff2(read('third_party/fonts/inter-latin-400.woff2'), { decompress: portOf((b) => new Uint8Array(brotliDecompressSync(b))) });
  const glyf = d.value.tables.find((t) => t.tag === 'glyf').data;
  assert.equal(decodeGlyfV0(glyf, 518).tag, 'Ok');
  const seen = new Set();
  for (let cut = 0; cut < glyf.length; cut += 97) {
    const r = decodeGlyfV0(glyf.subarray(0, cut), 518);
    assert.equal(r.tag, 'Err', `cut ${cut}`);
    seen.add(r.error.tag);
  }
  assert.ok(fonts.length === 1 && seen.has('StreamsOverflow') && seen.has('Truncated'), [...seen].join());
});

test('TrueType outlines sit at the hmtx side bearing: a glyph whose lsb disagrees with xMin is shifted by lsb − xMin (as FreeType, fontTools)', async () => {
  const { loadFont } = await import('../src/font.js');
  const { readFileSync } = await import('node:fs');
  const f = (await loadFont(new Uint8Array(readFileSync(new URL('../../fixtures/test-lsb-shift.ttf', import.meta.url))))).value;
  const xs = (gid) => f.path(gid).value.filter((s) => 'x' in s).map((s) => s.x);
  assert.equal(Math.min(...xs(f.glyphOf(0x41))), 90, 'A: stored xMin 100, lsb 90 → drawn at 90');
  assert.equal(Math.min(...xs(f.glyphOf(0x42))), 80, 'B: lsb equals xMin → unchanged');
});
