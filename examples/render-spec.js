// Render a scene spec locally, by the same code path a Worker uses (spec/src/spec.js buildScene).
// Fonts are fetched by URL — here from the local google/fonts checkout when the URL is the pinned
// raw.githubusercontent one — and checked against the spec's SHA-256.
//   node examples/render-spec.js <spec.json> [out.png] [--dpr 3] [--p.name value …]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadFont, draw } from '../index.js';
import { buildScene } from '../spec/src/spec.js';

const ROOT = new URL('../', import.meta.url).pathname;
const args = process.argv.slice(2);
const file = args[0], out = args[1] && !args[1].startsWith('--') ? args[1] : file.replace(/\.json$/, '.png');
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const params = Object.fromEntries(args.flatMap((a, i) => (a.startsWith('--p.') ? [[a.slice(4), args[i + 1]]] : [])));
const MIRROR = /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[0-9a-f]{40}\/(.*)$/;

const local = async (ref) => {
  const m = MIRROR.exec(ref.url);
  const bytes = m ? readFileSync(`${ROOT}conform/.ext/gfonts/${m[1].split('/').map(decodeURIComponent).join('/')}`)
    : new Uint8Array(await (await fetch(ref.url)).arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (ref.sha256 && sha !== ref.sha256) return { tag: 'Err', error: `sha256 ${sha} != ${ref.sha256}` };
  const f = await loadFont(bytes);
  return f.tag === 'Ok' ? { tag: 'Ok', value: { font: f.value, key: sha.slice(0, 16) } } : f;
};

const t = performance.now();
const r = await buildScene(JSON.parse(readFileSync(file, 'utf8')), { dpr: Number(opt('--dpr', 3)), params, loadFont: local });
if (r.tag === 'Err') { console.error(JSON.stringify(r.error, null, 1)); process.exit(1); }
const png = new Uint8Array(await new Response(draw.png(r.value.scene)).arrayBuffer());
writeFileSync(out, png);
console.log(`${out}  ${r.value.scene.width}×${r.value.scene.height}  ${r.value.scene.items.length} items  ${(png.length / 1024).toFixed(0)} KiB  ${(performance.now() - t).toFixed(0)} ms`);
