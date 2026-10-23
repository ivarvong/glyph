// node verify/draw.js
// Differential check of the drawing API against Chromium: each scene is rendered by glyph
// (PNG, scanline) and by Chromium/Skia from glyph's own SVG output of the same scene, and the
// RGB pixels are compared. The two share no rasterisation code, so agreement checks shape
// geometry (arcs, strokes, joins, caps), fill rules, gradient placement under transforms,
// gradient interpolation and alpha compositing. Dev-only: spawns Chromium.
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draw, linear, radial, rasterize, scanline, toSvg, chain, translate, rotate, scale } from '../index.js';
import { decodePng, toRgba } from './pngdecode.js';

const shellDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium_headless_shell'));
const SHELL = process.env.HEADLESS_SHELL ?? join('/opt/pw-browsers', shellDir,
  readdirSync(join('/opt/pw-browsers', shellDir)).find((d) => d.startsWith('chrome-')), 'headless_shell');
const tmp = mkdtempSync(join(tmpdir(), 'glyph-draw-'));
const OUT = new URL('../out/verify-draw/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/** Chromium's rendering of an SVG, as RGB, box-filtered from `scale`× to 1×. */
function chrome(svg, w, h, name, s) {
  const svgPath = join(tmp, `${name}.svg`), html = join(tmp, `${name}.html`), png = join(tmp, `${name}.png`);
  writeFileSync(svgPath, svg);
  writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:#fff}img{display:block;width:${w}px;height:${h}px}</style><img src="file://${svgPath}">`);
  execFileSync(SHELL, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${s}`,
    '--force-color-profile=srgb', '--virtual-time-budget=2000', '--allow-file-access-from-files',
    `--window-size=${w},${h}`, `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  const d = decodePng(readFileSync(png));
  if (d.width !== w * s || d.height !== h * s) throw new Error(`chrome ${name}: ${d.width}×${d.height}`); // bug: harness
  const rgba = toRgba(d), out = new Float64Array(w * h * 3);
  for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) {
    const o = (Math.floor(y / s) * w + Math.floor(x / s)) * 3, i = (y * w * s + x) * 4;
    for (let c = 0; c < 3; c++) out[o + c] += rgba[i + c] / (s * s);
  }
  return out;
}

const WHITE = [255, 255, 255, 255], INK = [23, 21, 15, 255];
const ORANGE = [243, 128, 32, 255], AMBER = [251, 173, 65, 255], TEAL = [43, 138, 143, 255], PLUM = [123, 94, 167, 255];
const ok = (r) => { if (r.tag === 'Err') throw new Error(JSON.stringify(r.error)); return r.value; }; // bug: fixed test data
const pentagram = (cx, cy, r) => draw.polygon([0, 2, 4, 1, 3].map((k) => [cx + r * Math.sin((2 * Math.PI * k) / 5), cy - r * Math.cos((2 * Math.PI * k) / 5)]));
const HEART = 'M 60 28 a 18 18 0 0 1 32 16 q -6 18 -32 38 q -26 -20 -32 -38 a 18 18 0 0 1 32 -16 z';

const SCENES = {
  shapes: () => draw.scene(480, 240, WHITE, [
    draw.fill(draw.circle(60, 60, 44), ORANGE),
    draw.fill(draw.ellipse(170, 60, 56, 30), TEAL),
    draw.fill(draw.roundRect(250, 20, 100, 80, 18), PLUM),
    draw.fill(draw.star(420, 62, 7, 46, 20), AMBER),
    draw.fill(pentagram(60, 175, 52), INK),
    draw.fill(pentagram(180, 175, 52), INK, { rule: 'evenodd' }),
    draw.fill(ok(draw.svgPath(HEART)), ORANGE, { transform: chain(translate(250, 120), scale(1.3)) }),
    draw.fill([...draw.circle(420, 175, 50), ...draw.circle(420, 175, 26)], TEAL, { rule: 'evenodd' }),
  ]),
  strokes: () => {
    const items = [];
    const zig = (x, y) => draw.polyline([[x, y + 40], [x + 30, y], [x + 60, y + 40], [x + 80, y + 4], [x + 100, y + 40]]);
    let col = 0;
    for (const join of ['miter', 'round', 'bevel']) for (const cap of ['butt', 'round', 'square']) {
      const x = 20 + (col % 3) * 150, y = 20 + Math.floor(col / 3) * 70;
      items.push(draw.fill(draw.stroke(zig(x, y), { width: 9, join, cap }), [INK, ORANGE, TEAL][col % 3]));
      col++;
    }
    const curve = ok(draw.svgPath('M 470 40 C 520 -10 600 90 640 30 S 700 120 620 190 Q 560 230 500 180 T 470 120'));
    items.push(draw.fill(draw.stroke(curve, { width: 7, cap: 'round' }), PLUM));
    items.push(draw.fill(draw.stroke(draw.circle(560, 120, 30), { width: 4 }), AMBER));
    items.push(draw.fill(draw.stroke(ok(draw.svgPath('M 700 30 L 760 90 M 700 90 L 760 30')), { width: 10 }), INK));
    items.push(draw.fill(draw.stroke(draw.polyline([[700, 150], [760, 160], [700, 170]]), { width: 6, miterLimit: 10 }), TEAL));
    return draw.scene(780, 240, WHITE, items);
  },
  gradients: () => draw.scene(560, 240, WHITE, [
    draw.fill(draw.roundRect(20, 20, 200, 90, 16), linear(20, 20, 220, 110, [ORANGE, AMBER, TEAL])),
    draw.fill(draw.circle(320, 70, 60), radial(300, 50, 80, [[0, [255, 240, 210, 255]], [0.4, AMBER], [1, [120, 30, 10, 255]]])),
    // Stops with alpha over a checker: tests premultiplied interpolation.
    ...Array.from({ length: 24 }, (_, i) => draw.fill(draw.rect(420 + (i % 6) * 20, 10 + Math.floor(i / 6) * 25, 10, 25), [180, 180, 180, 255])),
    draw.fill(draw.rect(420, 10, 120, 100), linear(420, 0, 540, 0, [[255, 0, 0, 255], [0, 0, 255, 0]])),
    // A gradient on transformed geometry: the gradient stays in scene space.
    draw.fill(draw.rect(-60, -25, 120, 50), linear(20, 0, 260, 0, [PLUM, ORANGE]), { transform: chain(translate(130, 180), rotate(-0.3), scale(1.4, 0.9)) }),
    draw.fill(ok(draw.svgPath(HEART)), radial(380, 185, 60, [[1, 1, 1, 255], TEAL]), { transform: chain(translate(320, 120), scale(1.1)) }),
  ]),
  alpha: () => draw.scene(420, 240, WHITE, [
    draw.fill(draw.circle(90, 90, 60), [243, 128, 32, 150]),
    draw.fill(draw.circle(150, 90, 60), [243, 128, 32, 150]),
    draw.fill(draw.circle(120, 140, 60), [43, 138, 143, 150]),
    draw.fill(draw.rect(240, 20, 150, 60), [0, 0, 0, 60]),
    draw.fill(draw.rect(270, 50, 150, 60), [0, 0, 0, 60]),
    draw.fill(draw.stroke(draw.polyline([[240, 150], [400, 150], [240, 220]]), { width: 14, join: 'round' }), [123, 94, 167, 140]),
    draw.fill(pentagram(320, 175, 50), [251, 173, 65, 160], { rule: 'evenodd' }),
  ]),
};

const rows = [];
let failed = 0;
for (const [name, make] of Object.entries(SCENES)) {
  const s = make();
  const ours = rasterize(s, scanline).rgba;
  writeFileSync(`${OUT}${name}.svg`, toSvg(s));
  writeFileSync(`${OUT}${name}.png`, new Uint8Array(await new Response(draw.png(s)).arrayBuffer()));
  for (const sc of [1, 4]) {
    const them = chrome(toSvg(s), s.width, s.height, `${name}@${sc}`, sc);
    const diffs = [];
    let sum = 0, max = 0, over = 0;
    for (let i = 0, p = 0; p < s.width * s.height; p++, i += 4) {
      let m = 0;
      for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(ours[i + c] - them[p * 3 + c]));
      diffs.push(m); sum += m; if (m > max) max = m; if (m > 16) over++;
    }
    diffs.sort((a, b) => a - b);
    const r = { scene: name, chrome: `${sc}×`, mean: +(sum / diffs.length).toFixed(3), p99: +diffs[Math.floor(diffs.length * 0.99)].toFixed(1), max: +max.toFixed(1), over16: over, pixels: diffs.length };
    // The gate is the 4× rendering box-filtered to 1×, which removes most of Skia's own
    // anti-aliasing approximation (its 1× edges are the coarser of the two; shown for scale).
    // Pass: mean under half a level and no pixel off by more than 16.
    if (sc === 1) r.pass = '(info)';
    else { r.pass = r.mean < 0.5 && r.over16 === 0; if (!r.pass) failed++; }
    rows.push(r);
  }
}
console.table(rows);
writeFileSync(`${OUT}report.json`, JSON.stringify(rows, null, 1));
const gated = rows.filter((r) => r.chrome === '4×').length;
console.log(failed ? `FAIL ${failed}/${gated}` : `draw vs Chromium: ${gated}/${gated} scenes within tolerance`);
process.exit(failed ? 1 : 0);
