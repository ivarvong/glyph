// Warm render benchmark + golden check.
//   node bench/render.js            -> p10/p50/p90 of the full render (tracing off), and output hashes
//   node bench/render.js --save     -> write bench/golden.json from this build
// Golden outputs use the stored zlib so PNG bytes are deterministic across zlib builds.
// Re-baselined once on purpose: PNG filter 'adaptive' -> 'none' (bytes changed, the
// 36 decoded images proved pixel-identical first; see README "Performance").
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { autoBrotli } from '../woff2/src/brotli.js';
import { loadFont, renderText } from '../render/src/text.js';
import { Target, TARGETS } from '../render/src/targets.js';
import { accumulate, scanline } from '../render/src/raster.js';
import { storedZlib } from '../render/src/png.js';
import { decodePng, toRgba } from '../verify/pngdecode.js';

const fx = (p) => new Uint8Array(readFileSync(new URL(`../third_party/fonts/${p}`, import.meta.url)));
const FONTS = { inter: fx('inter-latin-400.woff2'), sourceSerif: fx('source-serif-4-regular.otf.woff2') };
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

// 1. Golden: both fonts × 3 texts × 3 sizes × {svg, png-scanline, png-accumulate}.
const GOLD_TARGETS = [Target.Svg, Target.Png(scanline, storedZlib), Target.Png(accumulate, storedZlib)];
const hashes = {};
for (const [key, bytes] of Object.entries(FONTS)) {
  const font = (await loadFont(bytes, { brotli: autoBrotli })).value;
  for (const text of ['Cloudflare', 'AVAToWaYo office fluff', 'Workers']) for (const size of [13, 40, 96]) {
    const r = await renderText([{ fontKey: key, font, text, size }], { targets: GOLD_TARGETS });
    for (const o of r.value.outputs) {
      hashes[`${key}/${text}@${size}/${o.target}`] = sha(o.bytes);
      // Pixels too: an encoder change may alter bytes legitimately, never pixels.
      if (o.mime === 'image/png') hashes[`${key}/${text}@${size}/${o.target}/pixels`] = sha(toRgba(decodePng(o.bytes)));
    }
  }
}
const goldPath = new URL('./golden.json', import.meta.url);
if (process.argv.includes('--save')) { writeFileSync(goldPath, JSON.stringify(hashes, null, 1)); console.log(`saved ${Object.keys(hashes).length} golden hashes`); }
else if (existsSync(goldPath)) {
  const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
  const bad = Object.keys(gold).filter((k) => gold[k] !== hashes[k]);
  console.log(bad.length ? `GOLDEN MISMATCH ${bad.length}/${Object.keys(gold).length}: ${bad.slice(0, 6).join(', ') + ` (pixels: ${bad.filter((k) => k.endsWith('/pixels')).length}, bytes: ${bad.filter((k) => !k.endsWith('/pixels')).length})`}` : `golden: ${Object.keys(gold).length}/${Object.keys(gold).length} byte-identical`);
  if (bad.length) process.exitCode = 1;
}

// 2. Timing: the traced render (Inter, Cloudflare @96, default targets), tracing off.
const once = async () => {
  const f = await loadFont(FONTS.inter, { brotli: autoBrotli });
  return renderText([{ fontKey: 'inter', font: f.value, text: 'Cloudflare', size: 96 }], { targets: TARGETS });
};
for (let i = 0; i < 30; i++) await once();
const xs = [];
for (let i = 0; i < Number(process.env.N ?? 80); i++) { const a = performance.now(); await once(); xs.push(performance.now() - a); }
xs.sort((a, b) => a - b);
const q = (p) => xs[Math.floor(p * (xs.length - 1))].toFixed(2);
console.log(`warm render: p10 ${q(0.1)}  p50 ${q(0.5)}  p90 ${q(0.9)} ms  (n=${xs.length})`);
