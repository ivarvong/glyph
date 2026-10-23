// Vector drawing, checked against closed forms: areas of shapes and strokes (the rasterizer's
// coverage is exact area horizontally and 1/16-px sampled vertically), gradient values at
// known offsets, and the painter's model for translucent overlaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draw, linear, radial, rasterize, scanline, accumulate, toSvg } from '../../index.js';
import { scenePolygons } from '../../render/src/raster.js';
import { sceneKey } from '../../cache/src/key.js';

const WHITE = [255, 255, 255, 255], BLACK = [0, 0, 0, 255];

/** Total coverage (px²) of one item filled on a w×h canvas. */
const area = (item, w = 200, h = 200, r = scanline) => {
  const s = draw.scene(w, h, WHITE, [item]);
  let sum = 0;
  for (const b of scenePolygons(s)) for (const c of (b.evenOdd ? scanline : r).fill(b.polys, w, h, undefined, b.evenOdd)) sum += c;
  return sum;
};
// Curves are flattened by chords within FLATTEN_TOL (0.02 px), so a curved boundary of perimeter p
// may lose up to (2/3)·p·tol of area: that, not a relative bound, is the honest tolerance for arcs.
const arcTol = (perimeter) => (2 / 3) * perimeter * 0.02 + 1e-6;
const near = (got, want, abs, msg) => assert.ok(Math.abs(got - want) <= abs, `${msg}: ${got} vs ${want} (±${abs})`);
const close = (got, want, rel, msg) => assert.ok(Math.abs(got - want) <= rel * Math.max(1, Math.abs(want)), `${msg}: ${got} vs ${want}`);
const must = (r) => { assert.equal(r.tag, 'Ok', JSON.stringify(r.error)); return r.value; };

test('shape areas: rect exact, circle and ellipse within 0.1%', () => {
  close(area(draw.fill(draw.rect(10.25, 20.5, 30.5, 15.25), BLACK)), 30.5 * 15.25, 1e-6, 'rect');
  close(area(draw.fill(draw.circle(100.5, 100.2, 60.3), BLACK)), Math.PI * 60.3 ** 2, 1e-3, 'circle');
  close(area(draw.fill(draw.ellipse(100, 100, 80, 35), BLACK)), Math.PI * 80 * 35, 1e-3, 'ellipse');
  close(area(draw.fill(draw.roundRect(20, 30, 120, 80, 16), BLACK)), 120 * 80 - (4 - Math.PI) * 16 ** 2, 1e-3, 'roundRect');
  // Both rasterizers agree on a convex nonzero shape.
  close(area(draw.fill(draw.circle(100, 100, 50), BLACK), 200, 200, accumulate), Math.PI * 2500, 1e-3, 'circle, accumulate');
});

test('fill rule: even-odd punches the inner square, nonzero does not', () => {
  const two = [...draw.rect(20, 20, 100, 100), ...draw.rect(50, 50, 40, 40)]; // same winding
  close(area(draw.fill(two, BLACK)), 100 * 100, 1e-6, 'nonzero');
  close(area(draw.fill(two, BLACK, { rule: 'evenodd' })), 100 * 100 - 40 * 40, 1e-6, 'evenodd');
  // Even-odd is honoured even when the caller picks accumulate (it is routed to scanline).
  const s = draw.scene(140, 140, WHITE, [draw.fill(two, BLACK, { rule: 'evenodd' })]);
  assert.equal(rasterize(s, accumulate).data[70 * 140 + 70], 255, 'hole is white');
});

test('svgPath: arcs, relative, smooth and implicit commands', () => {
  // A circle as two arcs: area πr².
  close(area(draw.fill(must(draw.svgPath('M 140 100 A 40 40 0 1 1 60 100 A 40 40 0 1 1 140 100 Z')), BLACK)), Math.PI * 1600, 1e-3, 'arc circle');
  // Rotated elliptical arcs: a 30° ellipse drawn as two arcs has area π·a·b.
  close(area(draw.fill(must(draw.svgPath(`M ${100 + 60 * Math.cos(Math.PI / 6)} ${100 + 60 * Math.sin(Math.PI / 6)} A 60 25 30 1 1 ${100 - 60 * Math.cos(Math.PI / 6)} ${100 - 60 * Math.sin(Math.PI / 6)} A 60 25 30 1 1 ${100 + 60 * Math.cos(Math.PI / 6)} ${100 + 60 * Math.sin(Math.PI / 6)}z`)), BLACK)), Math.PI * 60 * 25, 2e-3, 'rotated ellipse');
  // Relative h/v and implicit lineto after m.
  close(area(draw.fill(must(draw.svgPath('m10 10 20 0 v20 h-20z')), BLACK)), 400, 1e-9, 'relative');
  // S and T reflect the previous control point.
  assert.deepEqual(must(draw.svgPath('M0 0C10 0 20 10 20 20S30 40 40 40')), must(draw.svgPath('M0 0C10 0 20 10 20 20C20 30 30 40 40 40')));
  assert.deepEqual(must(draw.svgPath('M0 0Q10 0 10 10T20 20')), must(draw.svgPath('M0 0Q10 0 10 10Q10 20 20 20')));
  // Flags may be packed without separators (SVG grammar).
  assert.deepEqual(must(draw.svgPath('M0 0a5 5 0 1010 0')), must(draw.svgPath('M0 0 a 5 5 0 1 0 10 0')));
  assert.deepEqual(must(draw.svgPath('')), []);
});

test('svgPath errors are values with a position', () => {
  assert.deepEqual(draw.svgPath('L 1 2'), { tag: 'Err', error: { at: 0, expected: 'M or m', found: 'L' } });
  assert.deepEqual(draw.svgPath('M 10'), { tag: 'Err', error: { at: 4, expected: '2 numbers for M', found: 'end of data' } });
  assert.deepEqual(draw.svgPath('M1 2 X'), { tag: 'Err', error: { at: 5, expected: 'a command', found: 'X' } });
  assert.equal(draw.svgPath('M0 0 A 1 1 0 2 0 5 5').tag, 'Err', 'flag must be 0 or 1');
});

test('stroke areas: caps, joins, miter limit, crossings', () => {
  const W = 10, seg = draw.line(50, 100, 150, 100);
  close(area(draw.fill(draw.stroke(seg, { width: W }), BLACK)), 100 * W, 1e-6, 'butt');
  close(area(draw.fill(draw.stroke(seg, { width: W, cap: 'square' }), BLACK)), 100 * W + W * W, 1e-6, 'square');
  near(area(draw.fill(draw.stroke(seg, { width: W, cap: 'round' }), BLACK)), 100 * W + Math.PI * 25, arcTol(2 * Math.PI * 5), 'round');
  // An L: two 60-px legs. Union of the legs is 1200 − 25; the join adds the outer corner.
  const L = draw.polyline([[20, 20], [80, 20], [80, 80]]);
  close(area(draw.fill(draw.stroke(L, { width: W, join: 'miter' }), BLACK)), 1200, 1e-6, 'miter');
  close(area(draw.fill(draw.stroke(L, { width: W, join: 'bevel' }), BLACK)), 1187.5, 1e-6, 'bevel');
  near(area(draw.fill(draw.stroke(L, { width: W, join: 'round' }), BLACK)), 1175 + Math.PI * 25 / 4, arcTol(2 * Math.PI * 5 / 4), 'round');
  // A 10° spike: miter ratio 1/sin(5°) ≈ 11.5 > 4, so the miter falls back to a bevel.
  const spike = draw.polyline([[20, 150], [180, 150], [20, 150 - 160 * Math.tan(Math.PI / 18)]]);
  assert.equal(area(draw.fill(draw.stroke(spike, { width: W }), BLACK)), area(draw.fill(draw.stroke(spike, { width: W, join: 'bevel' }), BLACK)));
  // An X: the crossing is counted once (pieces wound alike, nonzero unions them).
  const x = must(draw.svgPath('M30 30L170 170M30 170L170 30'));
  close(area(draw.fill(draw.stroke(x, { width: W }), BLACK)), 2 * W * 140 * Math.SQRT2 - W * W, 1e-4, 'X');
  // Direction does not matter: a square stroked clockwise and anticlockwise.
  const cw = draw.stroke(draw.rect(40, 40, 100, 100), { width: W }), ccw = draw.stroke(draw.polygon([[40, 40], [40, 140], [140, 140], [140, 40]]), { width: W });
  close(area(draw.fill(cw, BLACK)), 110 * 110 - 90 * 90, 1e-6, 'closed cw');
  close(area(draw.fill(ccw, BLACK)), 110 * 110 - 90 * 90, 1e-6, 'closed ccw');
  // Zero-length subpaths: round and square caps make a dot, butt nothing (SVG 2 §13.5.7).
  near(area(draw.fill(draw.stroke(draw.line(50, 50, 50, 50), { width: W, cap: 'round' }), BLACK)), Math.PI * 25, arcTol(2 * Math.PI * 5), 'dot');
  assert.equal(draw.stroke(draw.line(50, 50, 50, 50), { width: W }).length, 0);
});

test('gradients: linear ramp, radial ends, premultiplied interpolation', () => {
  const s = draw.scene(256, 1, WHITE, [draw.fill(draw.rect(0, 0, 256, 1), linear(0, 0, 256, 0, [BLACK, WHITE]))]);
  const img = rasterize(s, scanline);
  assert.equal(img.channels, 1, 'gray stops keep the gray format');
  for (let x = 0; x < 256; x++) assert.ok(Math.abs(img.data[x] - (255 * (x + 0.5)) / 256) <= 1, `x=${x}: ${img.data[x]}`);
  // Stops given as [offset, colour]; an offset below an earlier one is raised to it (hard edge).
  const hard = rasterize(draw.scene(100, 1, WHITE, [draw.fill(draw.rect(0, 0, 100, 1), linear(0, 0, 100, 0, [[0.5, BLACK], [0.2, WHITE]]))]), scanline);
  assert.equal(hard.data[49], 0); assert.equal(hard.data[50], 255);
  const r = rasterize(draw.scene(101, 101, WHITE, [draw.fill(draw.rect(0, 0, 101, 101), radial(50.5, 50.5, 40, [[255, 0, 0, 255], [0, 0, 255, 255]]))]), scanline);
  assert.deepEqual([...r.data.subarray((50 * 101 + 50) * 3, (50 * 101 + 50) * 3 + 3)], [255, 0, 0], 'centre');
  assert.deepEqual([...r.data.subarray(0, 3)], [0, 0, 255], 'corner, beyond r');
  // Red → transparent blue: midway is half-transparent red, not purple.
  const pm = rasterize(draw.scene(100, 1, WHITE, [draw.fill(draw.rect(0, 0, 100, 1), linear(0, 0, 100, 0, [[255, 0, 0, 255], [0, 0, 255, 0]]))]), scanline);
  const mid = [...pm.data.subarray(50 * 3, 50 * 3 + 3)];
  assert.equal(mid[0], 255); assert.ok(Math.abs(mid[1] - mid[2]) <= 1 && Math.abs(mid[1] - 130) <= 3, `mid ${mid}`);
});

test('translucent overlaps stack; opaque overlaps share one pass', () => {
  const half = [255, 0, 0, 128];
  const a = draw.fill(draw.rect(0, 0, 60, 10), half), b = draw.fill(draw.rect(40, 0, 60, 10), half);
  const img = rasterize(draw.scene(100, 10, WHITE, [a, b]), scanline);
  const g = (x) => img.data[(5 * 100 + x) * 3 + 1];
  const k = 1 - 128 / 255;
  assert.equal(g(20), Math.round(255 * k), 'one layer');
  assert.equal(g(50), Math.round(Math.round(255 * k) * k), 'two layers');
  assert.equal(scenePolygons(draw.scene(100, 10, WHITE, [a, b])).length, 2);
  assert.equal(scenePolygons(draw.scene(100, 10, WHITE, [draw.fill(draw.rect(0, 0, 60, 10), BLACK), draw.fill(draw.rect(40, 0, 60, 10), BLACK)])).length, 1);
  // Disjoint translucent items still batch.
  assert.equal(scenePolygons(draw.scene(100, 10, WHITE, [draw.fill(draw.rect(0, 0, 10, 10), half), draw.fill(draw.rect(50, 0, 10, 10), half)])).length, 1);
});

test('cache keys and SVG carry paints and rules', () => {
  const p = draw.rect(0, 0, 10, 10);
  const key = (it) => sceneKey(draw.scene(10, 10, WHITE, [it]), {});
  const keys = new Set([key(draw.fill(p, BLACK)), key(draw.fill(p, BLACK, { rule: 'evenodd' })), key(draw.fill(p, linear(0, 0, 10, 0, [BLACK, WHITE]))), key(draw.fill(p, linear(0, 0, 10, 0, [WHITE, BLACK])))]);
  assert.equal(keys.size, 4);
  const svg = toSvg(draw.scene(10, 10, WHITE, [draw.fill(p, linear(0, 0, 10, 0, [BLACK, WHITE]), { transform: [2, 0, 0, 2, 1, 1], rule: 'evenodd' })]));
  assert.match(svg, /<linearGradient id="p0" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="10" y2="0" gradientTransform="matrix\(0\.5 0 0 0\.5 -0\.5 -0\.5\)">/);
  assert.match(svg, /fill-rule="evenodd" fill="url\(#p0\)"/);
});

test('bounds: ink extent, not control points', () => {
  const b = draw.bounds([draw.fill(draw.circle(50, 40, 20), BLACK), draw.fill(draw.rect(0, 70, 5, 5), BLACK, { transform: [2, 0, 0, 2, 10, 0] })]);
  assert.equal(b.tag, 'Some');
  const [x0, y0, x1, y1] = b.value; // circle 30..70 × 20..60; rect scaled and moved to 10..20 × 140..150
  assert.ok(Math.abs(x0 - 10) < 1e-9 && Math.abs(y0 - 20) < 1e-2 && Math.abs(x1 - 70) < 1e-2 && Math.abs(y1 - 150) < 1e-9, `${b.value}`);
  // A quadratic's control point (y = 50) overshoots; its ink stops at the apex, y = 25.
  const q = draw.bounds([draw.fill(must(draw.svgPath('M0 0Q50 50 100 0Z')), BLACK)]);
  assert.ok(Math.abs(q.value[3] - 25) < 0.02, `${q.value}`);
  assert.equal(draw.bounds([]).tag, 'None');
});

test('banded stream = whole-image raster for many batches across bands', async () => {
  const { encodePngBanded } = await import('../../render/src/stream.js');
  const { decodePng, toRgba } = await import('../../verify/pngdecode.js');
  const { rasterize: whole } = await import('../../render/src/raster.js');
  const items = [];
  let seed = 3;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  // Batches that start and end in different bands, translucent overlaps, gradients, even-odd,
  // shapes partly off-canvas and wholly off-canvas.
  for (let i = 0; i < 120; i++) {
    const x = rand() * 260 - 20, y = rand() * 300 - 30, r = 2 + rand() * 30;
    const paint = i % 7 === 0 ? radial(x, y, r, [[255, 255, 255, 255], [200, 30, 10, 120]]) : [Math.floor(rand() * 255), 90, 160, i % 3 ? 255 : 140];
    items.push(draw.fill(i % 5 ? draw.circle(x, y, r) : draw.star(x, y, 5, r, r / 2), paint, { rule: i % 4 ? 'nonzero' : 'evenodd' }));
  }
  items.push(draw.fill(draw.rect(0, 400, 10, 10), BLACK)); // below the canvas
  const s = draw.scene(240, 250, WHITE, items);
  const want = whole(s, scanline).rgba;
  for (const rows of [1, 7, 32, 300]) {
    const got = toRgba(decodePng(await encodePngBanded(s, scanline, (await import('../../index.js')).balancedZlib, { rows })));
    assert.ok(Buffer.from(got).equals(Buffer.from(want)), `rows=${rows}`);
  }
});

test('ribbon strokes: a stroked circle is two loops, with the exact ring area', () => {
  for (const [r, w] of [[60, 4], [40, 20], [12, 6]]) {
    const p = draw.stroke(draw.circle(100, 100, r), { width: w });
    const loops = p.filter((s) => s.tag === 'MoveTo').length;
    assert.equal(loops, 2, `r=${r} w=${w}: ${loops} loops`);
    const want = Math.PI * ((r + w / 2) ** 2 - (r - w / 2) ** 2);
    near(area(draw.fill(p, BLACK)), want, arcTol(2 * Math.PI * (2 * r)) + 2 * Math.PI * r * 0.02, `ring r=${r} w=${w}`);
  }
  // Thicker than its curvature allows (r < w/2): inner offsets would fold, so it falls back to pieces
  // and still covers the full disc.
  near(area(draw.fill(draw.stroke(draw.circle(100, 100, 6), { width: 20 }), BLACK)), Math.PI * 16 ** 2, arcTol(2 * Math.PI * 16) + 2, 'thick ring = disc');
});

test('ribbon strokes: an S curve with round joins matches the piecewise union', () => {
  // A smooth curve: ribbons everywhere. Its area must equal width × length (to tolerance).
  const c = must(draw.svgPath('M 20 100 C 60 20 100 180 140 100 S 200 40 190 140'));
  const pts = draw.subpaths(c, 0.02)[0].pts;
  let L = 0;
  for (let i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  for (const join of ['miter', 'round', 'bevel']) {
    const p = draw.stroke(c, { width: 8, join });
    assert.ok(p.filter((s) => s.tag === 'MoveTo').length <= 3, `${join}: few pieces`);
    near(area(draw.fill(p, BLACK)), 8 * L, 8 * L * 2e-3, `S ${join}`);
  }
});

test('stroked (deferred) renders the same pixels as fill(stroke(...)) and holds only its source', () => {
  const src = must(draw.svgPath('M 20 20 C 80 0 120 160 180 90 L 60 170 Z M 30 150 L 90 120'));
  const opts = { width: 9, join: 'round', cap: 'square' };
  const eager = rasterize(draw.scene(200, 200, WHITE, [draw.fill(draw.stroke(src, opts), [200, 40, 20, 180])]), scanline).data;
  const d = draw.stroked(src, opts);
  const lazy = rasterize(draw.scene(200, 200, WHITE, [draw.fill(d, [200, 40, 20, 180])]), scanline).data;
  assert.ok(Buffer.from(eager).equals(Buffer.from(lazy)));
  assert.equal(d.tag, 'Deferred');
  // The hull contains the ink.
  const ink = draw.bounds([draw.fill(d, BLACK)]).value;
  assert.ok(d.hull[0] <= ink[0] && d.hull[1] <= ink[1] && d.hull[2] >= ink[2] && d.hull[3] >= ink[3], `${d.hull} ⊇ ${ink}`);
});

test('a batch unions items correctly whatever their winding (outlined glyph stays solid)', async () => {
  // Two opaque items of one colour share a coverage pass. One wound each way: their union must be
  // the union, not a cancellation (the bug: an outlined headline rendered hollow).
  const cw = draw.rect(20, 20, 60, 60), ccw = draw.polygon([[50, 50], [50, 110], [110, 110], [110, 50]]);
  const s = draw.scene(130, 130, WHITE, [draw.fill(cw, BLACK), draw.fill(ccw, BLACK)]);
  assert.equal(scenePolygons(s).length, 1, 'one batch');
  const img = rasterize(s, scanline);
  assert.equal(img.data[65 * 130 + 65], 0, 'the overlap is ink');
  close(area(draw.fill([...cw], BLACK)) + area(draw.fill(ccw, BLACK)) - 30 * 30, 60 * 60 * 2 - 30 * 30, 1e-9, 'sanity');
  // Even-odd items never union across an overlap: each keeps its own parity.
  const e1 = draw.fill(draw.rect(10, 10, 60, 60), BLACK, { rule: 'evenodd' }), e2 = draw.fill(draw.rect(40, 40, 60, 60), BLACK, { rule: 'evenodd' });
  const img2 = rasterize(draw.scene(120, 120, WHITE, [e1, e2]), scanline);
  assert.equal(img2.data[55 * 120 + 55], 0, 'even-odd overlap stays ink');
});
