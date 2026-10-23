// Emit every examples/posters.js scene as a scene spec (out/specs/<name>.json), built at DPR 1 so
// the spec is in CSS px; a renderer picks the DPR. Fonts are referenced by pinned upstream URL and
// SHA-256 (examples/specs/fonts.js), never embedded. Each spec is then rebuilt by the Worker's
// code path (buildScene, fonts from third_party/fonts/) and its pixels compared with the direct render.
//   node examples/emit-specs.js
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

process.env.DPR = '1';
process.env.ONLY = 'none'; // load the scene builders without rendering them
const ROOT = new URL('../', import.meta.url).pathname;
const { SCENES } = await import('./posters.js');
const { FIXTURE_FONTS, POSTER_FONTS } = await import('./specs/fonts.js');
const { toSpec } = await import('../spec/src/emit.js');
const { parseSpec, buildScene } = await import('../spec/src/spec.js');
const { loadFont } = await import('../index.js');
const { autoBrotli } = await import('../woff2/src/brotli.js');
const { rasterize, scanline } = await import('../render/src/raster.js');

const bytesOf = (url) => new Uint8Array(readFileSync(`${ROOT}${FIXTURE_FONTS[url]}`));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const FONT_URLS = new Map(Object.entries(POSTER_FONTS).map(([k, url]) => [k, { url, sha256: sha(bytesOf(url)) }]));
const loaded = new Map();
const local = async (ref) => {
  if (!loaded.has(ref.url)) {
    const b = bytesOf(ref.url), f = await loadFont(b, { brotli: autoBrotli });
    loaded.set(ref.url, f.tag === 'Ok' ? { tag: 'Ok', value: { font: f.value, key: sha(b).slice(0, 16) } } : f);
  }
  return loaded.get(ref.url);
};

const dir = `${ROOT}out/specs/`;
mkdirSync(dir, { recursive: true });
for (const [name, build] of Object.entries(SCENES)) {
  const scene = build();
  const r = toSpec(scene, FONT_URLS);
  if (r.tag === 'Err') { console.error(`${name}: ${r.error}`); process.exitCode = 1; continue; }
  const json = JSON.stringify(r.value);
  const check = parseSpec(JSON.parse(json));
  if (check.tag === 'Err') { console.error(`${name}: emitted an invalid spec`, check.error.slice(0, 3)); process.exitCode = 1; continue; }
  const built = await buildScene(JSON.parse(json), { dpr: 1, params: {}, loadFont: local });
  if (built.tag === 'Err') { console.error(`${name}: spec does not build`, JSON.stringify(built.error).slice(0, 300)); process.exitCode = 1; continue; }
  const a = rasterize(scene, scanline).rgba, b = rasterize(built.value.scene, scanline).rgba;
  let sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); sum += d; if (d > max) max = d; }
  writeFileSync(`${dir}${name}.json`, json);
  console.log(`${name.padEnd(12)} ${String(r.value.items.length).padStart(6)} items  ${(json.length / 1024).toFixed(0).padStart(6)} KiB json  ${(gzipSync(json).length / 1024).toFixed(0).padStart(5)} KiB gzip  ${Object.keys(r.value.fonts).length} fonts  vs direct: mean ${(sum / a.length).toFixed(3)} max ${max}`);
}
