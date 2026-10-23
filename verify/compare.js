// node verify/compare.js
// Four rasterizers, pairwise, on the same layouts:
//   A  accumulate (ours)     B  scanline (ours)
//   FT FreeType 2.13 (ref/*.pgm, unhinted)
//   SK Chromium/Skia rendering our SVG output (headless_shell screenshot)
// Writes verify/report.json and prints a table. Dev-only: spawns Chromium.
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allFonts } from '../sfnt/test/fixtures.js';
import { shape } from '../shape/src/shape.js';
import { layout } from '../render/src/scene.js';
import { scenePolygons, accumulate, scanline } from '../render/src/raster.js';
import { toSvg } from '../render/src/svg.js';
import { decodePng, coverageFromPng } from './pngdecode.js';
import { signedArea } from './area.js';

const CASES = [['Cloudflare', 96], ['Cloudflare', 24], ['Workers', 13], ['AVAToWaYo', 40]];
const shellDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium_headless_shell'));
const SHELL = process.env.HEADLESS_SHELL ?? join('/opt/pw-browsers', shellDir,
  readdirSync(join('/opt/pw-browsers', shellDir)).find((d) => d.startsWith('chrome-')), 'headless_shell');
const tmp = mkdtempSync(join(tmpdir(), 'glyph-verify-'));

const pgm = (p) => {
  const b = readFileSync(p);
  const m = b.toString('latin1', 0, 40).match(/^P5 (\d+) (\d+) 255\n/);
  return { w: +m[1], h: +m[2], cov: Float32Array.from(b.subarray(m[0].length), (v) => v / 255) };
};

function chrome(svg, w, h, name, scale = 1) {
  const svgPath = join(tmp, `${name}.svg`), html = join(tmp, `${name}.html`), png = join(tmp, `${name}.png`);
  writeFileSync(svgPath, svg);
  writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:#fff}img{display:block}</style><img src="file://${svgPath}">`);
  execFileSync(SHELL, ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`,
    '--force-color-profile=srgb', '--virtual-time-budget=2000', '--allow-file-access-from-files',
    `--window-size=${w},${h}`, `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  const d = decodePng(readFileSync(png));
  if (d.width !== w * scale || d.height !== h * scale) throw new Error(`chrome ${name}: ${d.width}×${d.height} != ${w * scale}×${h * scale}`);
  const hi = coverageFromPng(d);
  if (scale === 1) return hi;
  // Box-filter scale×scale blocks back to 1×: removes most of Skia's own AA quantisation.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) out[Math.floor(y / scale) * w + Math.floor(x / scale)] += hi[y * w * scale + x] / (scale * scale);
  return out;
}

const stats = (a, b) => {
  let sum = 0, signed = 0, max = 0, over = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] - b[i]) * 255;
    sum += Math.abs(d); signed += d;
    if (Math.abs(d) > max) max = Math.abs(d);
    if (Math.abs(d) > 8) over++;
  }
  return { mean: +(sum / a.length).toFixed(3), bias: +(signed / a.length).toFixed(3), max: +max.toFixed(1), over8: over };
};

const report = [];
const seen = new Set();
for (const { key, font } of await allFonts()) {
  if (seen.has(key)) continue; // containers are already proven identical; one file per font
  seen.add(key);
  for (const [text, size] of CASES) {
    const run = shape(font, text).value;
    const scene = layout([{ font, fontKey: key, glyphs: run, size }], { padding: 8 }).value;
    const { width: w, height: h } = scene;
    const polys = scenePolygons(scene)[0].polys;
    const ft = pgm(new URL(`../third_party/ref/ft-${key}-${text}-${size}.pgm`, import.meta.url));
    const R = {
      A: accumulate.fill(polys, w, h),
      B: scanline.fill(polys, w, h),
      FT: ft.cov,
      SK: chrome(toSvg(scene), w, h, `${key}-${text}-${size}`),
      SK4: chrome(toSvg(scene), w, h, `${key}-${text}-${size}-x4`, 4),
    };
    const names = Object.keys(R);
    const pairs = {};
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) pairs[`${names[i]}~${names[j]}`] = stats(R[names[i]], R[names[j]]);
    // Ink conservation: total coverage per rasterizer, relative to B.
    const ink = Object.fromEntries(names.map((n) => [n, +R[n].reduce((s, v) => s + v, 0).toFixed(1)]));
    // Exact analytic area (Green's theorem); equals union ink only for fonts without overlapping contours.
    const s = size / font.unitsPerEm;
    ink.exactSum = +scene.items.reduce((t, it) => t + Math.abs(signedArea(it.path)) * s * s, 0).toFixed(1);
    report.push({ font: key, text, size, w, h, pairs, ink });
  }
}
writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 1));
const cols = ['A~B', 'B~SK', 'B~SK4', 'A~SK4', 'B~FT', 'FT~SK4'];
console.log('mean |Δ| / max |Δ| / pixels with |Δ|>8, in 0-255 units');
console.log('case'.padEnd(30) + cols.map((c) => c.padStart(20)).join(''));
for (const r of report) {
  console.log(`${r.font} ${r.text}@${r.size}`.padEnd(30) + cols.map((c) => {
    const s = r.pairs[c];
    return `${s.mean}/${s.max}/${s.over8}`.padStart(20);
  }).join(''));
}
console.log('\nink (Σ coverage, px²)');
for (const r of report) console.log(`${r.font} ${r.text}@${r.size}`.padEnd(30), JSON.stringify(r.ink));
