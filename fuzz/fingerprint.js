// Behavioural fingerprint of the pipeline over a set of inputs, for refactor differentials.
//   node fuzz/fingerprint.js > fuzz/baseline.json          (before)
//   node fuzz/fingerprint.js --compare fuzz/baseline.json   (after: every Ok output must be identical)
// Fingerprint per input: load outcome; for Ok, hashes of the first 96 glyph outlines, the shaped
// glyph run, and the PNG bytes. Errors are compared by outcome class (Ok vs Err), not by name.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { regressionFiles } from './regressions.js';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { loadFont } from '../sfnt/src/font.js';
import { jsBrotli, portOf } from '../woff2/src/brotli.js';
import { shape } from '../shape/src/shape.js';
import { renderText } from '../render/src/text.js';
import { scanline } from '../render/src/raster.js';
import { fastZlib } from '../render/src/png.js';
import { encodePngBanded } from '../render/src/stream.js';
import { NOOP_SPAN } from '../otel-compact/src/trace.js';

const H = (x) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16);
const corpus = new URL('./corpus/', import.meta.url);
const fonts = new URL('../third_party/fonts/', import.meta.url);
/** [name, url]: fonts/<font> (fetched), corpus/<sha>.bin, regressions/<name>.bin (own or rebuilt). */
const files = [
  ...readdirSync(fonts).filter((f) => /\.(woff2?|otf)$/.test(f)).map((f) => [`fonts/${f}`, new URL(f, fonts)]),
  ...(existsSync(corpus) ? readdirSync(corpus).filter((f) => f.endsWith('.bin')).map((f) => [`corpus/${f}`, new URL(f, corpus)]) : []),
  ...regressionFiles().map((r) => [`regressions/${r.name}`, r.url]),
];
const isOk = (r) => r && r.tag === 'Ok';

async function fingerprint(bytes) {
  const f = await loadFont(bytes, { brotli: jsBrotli, inflate: (b, m) => portOf((x, max) => new Uint8Array(inflateSync(x, { maxOutputLength: max })))(b, NOOP_SPAN, m) });
  if (!isOk(f)) return { load: 'Err' };
  const font = f.value, glyphs = [];
  for (let g = 0; g < Math.min(font.numGlyphs, 96); g++) { const p = font.path(g); glyphs.push(isOk(p) ? H(p.value) : 'Err'); }
  const s = shape(font, 'Hfiffl AVTo 0123 office —é');
  const r = await renderText([{ font, fontKey: 'f', text: 'Hfiffl AVTo', size: 24 }], { targets: [] });
  const png = isOk(r) ? H(Buffer.from(await encodePngBanded(r.value.scene, scanline, fastZlib)).toString('base64')) : 'Err';
  return { load: 'Ok', glyphs: H(glyphs), shape: isOk(s) ? H(s.value) : 'Err', png };
}

const out = {};
for (const [name, u] of files) {
  try { out[name] = await fingerprint(new Uint8Array(readFileSync(u))); } catch (e) { out[name] = { load: `THROW ${e.constructor.name}` }; }
}
const ci = process.argv.indexOf('--compare');
if (ci < 0) { process.stdout.write(JSON.stringify(out, null, 1)); process.exit(0); }
const base = JSON.parse(readFileSync(process.argv[ci + 1], 'utf8'));
let same = 0, fixed = 0; const changed = [];
for (const [k, b] of Object.entries(base)) {
  const a = out[k];
  if (!a) continue;
  if (JSON.stringify(a) === JSON.stringify(b)) same++;
  else if (b.load.startsWith('THROW') && !a.load.startsWith('THROW')) fixed++;
  else changed.push(`${k}: ${JSON.stringify(b)} → ${JSON.stringify(a)}`);
}
console.log(`${same} identical, ${fixed} former throws now return values, ${changed.length} changed`);
for (const c of changed.slice(0, 20)) console.log(`  ${c}`);
if (changed.length) process.exitCode = 1;
