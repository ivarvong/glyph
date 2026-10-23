import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32 as nodeCrc32, inflateSync } from 'node:zlib';
import { allFonts } from '../../sfnt/test/fixtures.js';
import { canonical, outlineDistance } from '../../sfnt/test/canon.js';
import { shape } from '../../shape/src/shape.js';
import { layout } from '../src/scene.js';
import { scenePolygons, accumulate, scanline, rasterize, channelsFor } from '../src/raster.js';
import { toSvg, pathData } from '../src/svg.js';
import { crc32, adler32, encodePng, filterRows, unfilteredRows } from '../src/png.js';
import { ZLIBS, TARGETS, renderTarget } from '../src/targets.js';
import { renderText } from '../src/text.js';
import { Seg } from '../../outline/src/path.js';
import { signedArea } from '../../verify/area.js';
import { decodePng, toRgba } from '../../verify/pngdecode.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';

const CASES = [['Cloudflare', 96], ['Cloudflare', 24], ['Workers', 13], ['AVAToWaYo', 40]];
const SUB = 16; // scanline's vertical samples per pixel
const pgm = (p) => {
  const b = readFileSync(new URL(`../../third_party/ref/${p}`, import.meta.url));
  const m = b.toString('latin1', 0, 40).match(/^P5 (\d+) (\d+) 255\n/);
  return { w: +m[1], h: +m[2], cov: Float32Array.from(b.subarray(m[0].length), (v) => v / 255) };
};
const sum = (a) => a.reduce((s, v) => s + v, 0);

async function scenes() {
  const out = [];
  const seen = new Set();
  for (const { key, font } of await allFonts()) {
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [text, size] of CASES) {
      const scene = layout([{ font, fontKey: key, glyphs: shape(font, text).value, size }], { padding: 8 }).value;
      const polys = scenePolygons(scene)[0].polys;
      out.push({ key, font, text, size, scene, polys, A: accumulate.fill(polys, scene.width, scene.height), B: scanline.fill(polys, scene.width, scene.height) });
    }
  }
  return out;
}

test('layout matches the FreeType reference canvas exactly (same rule, independent implementation)', async () => {
  for (const s of await scenes()) {
    const ref = pgm(`ft-${s.key}-${s.text}-${s.size}.pgm`);
    assert.deepEqual([s.scene.width, s.scene.height], [ref.w, ref.h], `${s.key} ${s.text}@${s.size}`);
  }
});

test('Source Serif (no overlapping contours): the two rasterizers agree within scanline sampling', async () => {
  for (const s of (await scenes()).filter((x) => x.key === 'sourceSerif')) {
    for (let i = 0; i < s.A.length; i++) {
      assert.ok(Math.abs(s.A[i] - s.B[i]) <= 1 / SUB, `${s.text}@${s.size} px ${i}: ${s.A[i]} vs ${s.B[i]}`);
    }
  }
});

test('Inter (overlapping contours): every disagreement beyond sampling is accumulate over-covering', async () => {
  // Theory: accumulate computes min(1, |Σ signed area|) per pixel; where two contours of one
  // glyph overlap inside a pixel, that sum exceeds the union's area. So A ≥ B wherever they differ.
  for (const s of (await scenes()).filter((x) => x.key === 'inter')) {
    let n = 0;
    for (let i = 0; i < s.A.length; i++) {
      if (Math.abs(s.A[i] - s.B[i]) > 1 / SUB) {
        n++;
        assert.ok(s.A[i] > s.B[i], `${s.text}@${s.size} px ${i}: A ${s.A[i]} < B ${s.B[i]}`);
      }
    }
    assert.ok(n <= s.A.length * 0.002, `${s.text}@${s.size}: ${n} pixels`);
  }
});

test('ink equals the exact analytic area (Green\'s theorem) where contours do not overlap', async () => {
  for (const s of (await scenes()).filter((x) => x.key === 'sourceSerif')) {
    const k = s.size / s.font.unitsPerEm;
    const exact = s.scene.items.reduce((t, it) => t + Math.abs(signedArea(it.path)) * k * k, 0);
    for (const [name, cov] of [['A', s.A], ['B', s.B]]) {
      const rel = Math.abs(sum(cov) - exact) / exact;
      assert.ok(rel < 0.003, `${s.text}@${s.size} ${name}: ink ${sum(cov)} vs exact ${exact} (${(rel * 100).toFixed(2)}%)`);
    }
  }
});

test('scanline agrees with FreeType 2.13 (unhinted): mean < 1/255, ink within 1.5%', async () => {
  for (const s of await scenes()) {
    const ft = pgm(`ft-${s.key}-${s.text}-${s.size}.pgm`).cov;
    let d = 0;
    for (let i = 0; i < ft.length; i++) d += Math.abs(ft[i] - s.B[i]);
    assert.ok(d / ft.length < 1 / 255, `${s.key} ${s.text}@${s.size}: mean ${(d / ft.length * 255).toFixed(3)}/255`);
    const rel = Math.abs(sum(ft) - sum(s.B)) / sum(s.B);
    assert.ok(rel < 0.015, `${s.key} ${s.text}@${s.size}: ink ${(rel * 100).toFixed(2)}%`);
  }
});

// ---- PNG

test('crc32 and adler32 against node:zlib and RFC test vectors', () => {
  const data = new Uint8Array(100_000).map((_, i) => (i * 2654435761) >>> 24);
  assert.equal(crc32(data), nodeCrc32(data));
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); // CRC-32 check value
  assert.equal(adler32(new TextEncoder().encode('Wikipedia')), 0x11e60398); // RFC 1950 worked example
  // adler32 is validated by inflate on every PNG below, including > 5552-byte blocks.
});

const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

test('both zlib encoders: valid streams, identical inflated bytes, pixel-exact PNG round trip', async () => {
  const s = (await scenes()).find((x) => x.key === 'inter' && x.size === 96);
  const img = rasterize(s.scene, scanline, NOOP_SPAN, { channels: 4 });
  const filtered = unfilteredRows(img.data, img.width, img.height, 4);
  const pngs = await Promise.all(ZLIBS.map((z) => encodePng(img, z)));
  // The adaptive filter path still round-trips to the same pixels.
  for (const z of ZLIBS) {
    const d = decodePng(await encodePng(img, z, NOOP_SPAN, { filter: 'adaptive' }));
    assert.ok(same(d.raw, filterRows(img.data, img.width, img.height, 4)), `${z.name} adaptive: inflated bytes`);
    assert.ok(same(d.px, img.data), `${z.name} adaptive: pixels`);
  }
  for (const [i, png] of pngs.entries()) {
    const d = decodePng(png);
    assert.deepEqual([d.width, d.height, d.bpp], [img.width, img.height, 4], ZLIBS[i].name);
    assert.ok(same(d.raw, filtered), `${ZLIBS[i].name}: inflated bytes`);
    assert.ok(same(d.px, img.data), `${ZLIBS[i].name}: pixels`);
  }
  assert.ok(pngs[0].length < pngs[1].length / 4, `native ${pngs[0].length} vs stored ${pngs[1].length}`);
  assert.ok(pngs[2].length < pngs[1].length / 4, `fast ${pngs[2].length} vs stored ${pngs[1].length}`);
  // Stored blocks split at 65535 bytes: the 96px image spans several.
  assert.ok(filtered.length > 3 * 65535);
  assert.deepEqual(inflateSync((await ZLIBS[1].deflate(new Uint8Array(0)))), Buffer.alloc(0));
});

test('gray / RGB / RGBA: same pixels in every format, narrowest chosen exactly when lossless', async () => {
  const base = (await scenes()).find((x) => x.key === 'inter' && x.size === 40).scene;
  const recolor = (fill, background) => ({ ...base, background, items: base.items.map((it) => ({ ...it, fill })) });
  const cases = [
    ['black on white', recolor([0, 0, 0, 255], [255, 255, 255, 255]), 1],
    ['50% gray on white', recolor([0, 0, 0, 128], [255, 255, 255, 255]), 1],
    ['orange on white', recolor([243, 128, 32, 255], [255, 255, 255, 255]), 3],
    ['black on transparent', recolor([0, 0, 0, 255], [0, 0, 0, 0]), 4],
  ];
  for (const [name, scene, want] of cases) {
    assert.equal(channelsFor(scene), want, name);
    const ref = rasterize(scene, scanline, NOOP_SPAN, { channels: 4 }).data;
    for (const C of /** @type {const} */ ([1, 3, 4])) {
      if (C < want) continue; // narrower than chosen would lose information
      const img = rasterize(scene, scanline, NOOP_SPAN, { channels: C });
      assert.equal(img.data.length, img.width * img.height * C);
      assert.ok(same(img.rgba, ref), `${name}: ${C}-channel composite == RGBA composite`);
      for (const z of ZLIBS) for (const filter of /** @type {const} */ (['none', 'adaptive'])) {
        const d = decodePng(await encodePng(img, z, NOOP_SPAN, { filter }));
        assert.equal(d.bpp, C, `${name} ${z.name}`);
        assert.ok(same(toRgba(d), ref), `${name}: ${C}ch ${z.name} ${filter} decodes to the RGBA pixels`);
      }
    }
  }
});

// ---- SVG

/** Minimal SVG path-data parser for the absolute commands pathData emits. */
const parseD = (d) => {
  const out = [];
  for (const [, c, args] of d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    const n = args.trim() ? args.trim().split(/\s+/).map(Number) : [];
    out.push(c === 'M' ? Seg.MoveTo(...n) : c === 'L' ? Seg.LineTo(...n) : c === 'Q' ? Seg.QuadTo(...n) : c === 'C' ? Seg.CubicTo(...n) : Seg.Close);
  }
  return out;
};

test('SVG path data round-trips every glyph of both fonts within 1e-4 font units', async () => {
  const seen = new Set();
  for (const { key, font } of await allFonts()) {
    if (seen.has(key)) continue;
    seen.add(key);
    for (let g = 0; g < font.numGlyphs; g++) {
      const p = font.path(g).value;
      const d = outlineDistance(canonical(parseD(pathData(p))), canonical(p));
      assert.ok(d <= 5e-5, `${key} glyph ${g}: ${d}`);
    }
  }
});

test('SVG: one <use> per inked glyph, outlines de-duplicated, transforms exact', async () => {
  const s = (await scenes()).find((x) => x.key === 'inter' && x.text === 'Workers');
  const svg = toSvg(s.scene, { title: 'Workers' });
  assert.equal((svg.match(/<use /g) ?? []).length, s.scene.items.length);
  assert.equal((svg.match(/<path id=/g) ?? []).length, new Set(s.scene.items.map((i) => i.key)).size);
  assert.ok(new Set(s.scene.items.map((i) => i.key)).size < s.scene.items.length, '"r" appears twice in Workers');
  // 13/2048 must survive exactly: a 4-decimal rounding made glyphs 0.75% small.
  const m = [...svg.matchAll(/matrix\(([^)]*)\)/g)].map((x) => x[1].split(' ').map(Number));
  assert.deepEqual(m.map((r) => r.slice(0, 4)), s.scene.items.map((i) => i.transform.slice(0, 4)));
  assert.ok(svg.includes('<title>Workers</title>'));
});

// ---- End to end

test('renderText: Cloudflare in both fonts -> SVG + PNG, both targets, n lines', async () => {
  const fonts = await allFonts();
  const inter = fonts.find((f) => f.key === 'inter').font, ss = fonts.find((f) => f.key === 'sourceSerif').font;
  const r = await renderText([
    { fontKey: 'inter', font: inter, text: 'Cloudflare', size: 48 },
    { fontKey: 'sourceSerif', font: ss, text: 'Cloudflare', size: 48 },
  ]);
  assert.equal(r.tag, 'Ok');
  assert.deepEqual(r.value.outputs.map((o) => o.mime), ['image/svg+xml', 'image/png']);
  assert.equal(r.value.scene.items.length, 10 + 9);
  const png = decodePng(r.value.outputs[1].bytes);
  assert.deepEqual([png.width, png.height], [r.value.scene.width, r.value.scene.height]);
  assert.equal(TARGETS.length, 2);
  const again = await renderTarget(r.value.scene, TARGETS[1]);
  assert.deepEqual(again.bytes, r.value.outputs[1].bytes, 'deterministic');
});

test('fast deflate: seeded fuzz round-trips through node:zlib and DecompressionStream', async () => {
  const { fastZlib } = await import('../src/png.js');
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const gens = {
    empty: () => new Uint8Array(0),
    one: () => new Uint8Array([7]),
    random: (n) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256)),
    runs: (n) => { const a = new Uint8Array(n); let v = 0; for (let i = 0; i < n; i++) { if (rnd() < 0.01) v = Math.floor(rnd() * 256); a[i] = v; } return a; },
    repeats: (n) => { const a = new Uint8Array(n); const unit = Math.floor(rnd() * 300) + 1; for (let i = 0; i < n; i++) a[i] = i < unit ? Math.floor(rnd() * 256) : a[i - unit]; return a; },
    farRepeat: (n) => { const a = Uint8Array.from({ length: n }, () => Math.floor(rnd() * 4)); const d = 32768; for (let i = d; i < n; i++) if (rnd() < 0.9) a[i] = a[i - d]; return a; },
  };
  const inflateNative = async (b) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  let cases = 0;
  for (const [name, g] of Object.entries(gens)) {
    for (const n of [0, 1, 2, 3, 257, 258, 259, 1000, 32767, 32768, 32769, 70000]) {
      const src = g(n);
      const z = await fastZlib.deflate(src);
      assert.deepEqual(new Uint8Array(inflateSync(z)), src, `${name} n=${n} via node:zlib`);
      assert.deepEqual(await inflateNative(z), src, `${name} n=${n} via DecompressionStream`);
      cases++;
    }
  }
  assert.equal(cases, 6 * 12);
});

test('flatten cache: hits reproduce misses bit for bit, within a scene and across renders', async () => {
  const { flattenCache } = await import('../src/raster.js');
  for (const { scene } of await scenes()) {
    const fresh = scenePolygons(scene); // per-call cache: misses then within-scene hits
    const shared = flattenCache();
    scenePolygons(scene, NOOP_SPAN, shared);
    const warm = scenePolygons(scene, NOOP_SPAN, shared); // every glyph a hit
    assert.equal(shared.stats.misses, new Set(scene.items.map((it) => `${it.key}|${it.transform.slice(0, 4)}`)).size);
    const flat = (gs) => Buffer.concat(gs.flatMap((g) => g.polys.map((p) => Buffer.from(p.buffer))));
    assert.ok(same(flat(fresh), flat(warm)));
  }
  const tiny = flattenCache({ maxBytes: 3000 });
  const { scene } = (await scenes())[0];
  scenePolygons(scene, NOOP_SPAN, tiny);
  assert.ok(tiny.stats.bytes <= 3000 && tiny.stats.evictions > 0, 'eviction bounds the cache by bytes');
});

test('banded PNG: same pixels and same zlib bytes as the whole-image encoder, any band height', async () => {
  const { encodePngBanded, pngStream } = await import('../src/stream.js');
  /** Concatenated IDAT payloads of a PNG. */
  const idat = (png) => {
    const b = Buffer.from(png), parts = [];
    for (let o = 8; o < b.length;) { const n = b.readUInt32BE(o); if (b.toString('latin1', o + 4, o + 8) === 'IDAT') parts.push(b.subarray(o + 8, o + 8 + n)); o += 12 + n; }
    return { data: Buffer.concat(parts), count: parts.length };
  };
  const all = await scenes();
  const picks = [all.find((x) => x.key === 'inter' && x.size === 96), all.find((x) => x.key === 'serif' && x.size === 13) ?? all[1]];
  for (const { scene } of picks) for (const r of [scanline, accumulate]) for (const z of ZLIBS) for (const filter of /** @type {const} */ (['none', 'adaptive'])) {
    const whole = await encodePng(rasterize(scene, r), z, NOOP_SPAN, { filter });
    const want = toRgba(decodePng(whole));
    for (const rows of [1, 7, 32, scene.height + 5]) {
      const banded = await encodePngBanded(scene, r, z, { rows, filter, idat: 1024 });
      const tag = `${r.name} ${z.name} ${filter} rows=${rows}`;
      assert.ok(same(toRgba(decodePng(banded)), want), `${tag}: pixels`);
      if (z.name !== 'native') assert.ok(same(idat(banded).data, idat(whole).data), `${tag}: zlib stream byte-identical`);
    }
  }
  // ReadableStream: pull-driven, same bytes as collecting.
  const { scene } = picks[0];
  const viaStream = Buffer.from(await new Response(pngStream(scene, scanline, ZLIBS[2], { rows: 16, idat: 1024 })).arrayBuffer());
  assert.ok(same(viaStream, await encodePngBanded(scene, scanline, ZLIBS[2], { rows: 16, idat: 1024 })));
  assert.ok(idat(viaStream).count > 1, 'streamed as several IDATs');
});

test('alongPath on a sampled circle reproduces onCircle (two implementations of text-on-curve)', async () => {
  const { run, must, onCircle, alongPath, arcLength } = await import('../src/compose.js');
  const { font } = (await allFonts())[0];
  const rn = must(run(font, 'f', 'Workers on a curve', 40));
  const r = 300, cx = 400, cy = 400;
  const a = onCircle(rn, { cx, cy, r, start: 0 }, [0, 0, 0, 255]);
  // Clockwise from the top, parametrised by angle; arc length = r·θ.
  const curve = arcLength((t) => [cx + r * Math.sin(2 * Math.PI * t), cy - r * Math.cos(2 * Math.PI * t)], 1 << 16);
  const b = alongPath(rn, curve, [0, 0, 0, 255]);
  assert.equal(a.length, b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) for (let k = 0; k < 6; k++) worst = Math.max(worst, Math.abs(a[i].transform[k] - b[i].transform[k]));
  assert.ok(worst < 1e-3, `max transform difference ${worst}`); // chord sampling error at 65536 samples
});

test('runFallback: each character from the first face that maps it; ligatures survive inside a face run', async () => {
  const { runFallback, run, must } = await import('../src/compose.js');
  const fonts = await allFonts();
  const inter = fonts.find((f) => f.key === 'inter').font, serif = fonts.find((f) => f.key !== 'inter').font;
  const faces = [{ font: inter, key: 'i' }, { font: serif, key: 's' }];
  const text = 'office π λ';
  const rn = must(runFallback(faces, text, 32));
  assert.equal(rn.missing, 0);
  const greek = rn.glyphs.filter((g) => g.fontKey === 's');
  assert.ok(greek.length >= 2 && greek.every((g) => 'πλ'.includes([...text][g.cluster])), 'π and λ came from the serif');
  // The Inter segment shapes exactly as Inter alone would (same gids, same advances).
  const alone = must(run(inter, 'i', 'office ', 32));
  assert.deepEqual(rn.glyphs.filter((g) => g.fontKey === 'i').slice(0, alone.glyphs.length).map((g) => [g.gid, g.ax]), alone.glyphs.map((g) => [g.gid, g.ax]));
  assert.equal(must(run(inter, 'i', 'π', 32)).missing, 1, 'without fallback the miss is counted, not hidden');
});
