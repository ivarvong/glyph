// Execute examples/worker-cached.ts as written, in Node, against stand-ins for what Workers
// provides: a WorkerEntrypoint base class, ctx.exports.Renders behind simulatedWorkersCache,
// an R2-shaped bucket, and ctx.waitUntil. Three module instances play three isolates.
//   node --experimental-strip-types --no-warnings examples/worker-cached-check.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { simulatedWorkersCache } from 'glyph/cache';
import { decodePng } from '../verify/pngdecode.js';

const src = readFileSync(new URL('./worker-cached.ts', import.meta.url), 'utf8')
  .replace(/^import \{ WorkerEntrypoint \} from 'cloudflare:workers';$/m, 'class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')
  .replace(/^import inter from .*$/m, "import { readFileSync } from 'node:fs';\nconst inter = readFileSync(new URL('../third_party/fonts/inter-latin-400.woff2', import.meta.url));");
mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
const file = new URL('../out/worker-cached-run.ts', import.meta.url);
writeFileSync(file, src);

const objects = new Map(), r2 = { gets: 0, puts: 0 };
const env = { RENDERS: {
  async get(k) { r2.gets++; const v = objects.get(k); return v ? { arrayBuffer: async () => v.slice().buffer } : null; },
  async put(k, v) { r2.puts++; objects.set(k, new Uint8Array(v)); },
} };
const pending = [];
const isolate = async (n) => (await import(`${file.href}?isolate=${n}`));
const iso1 = await isolate(1);
// The cache-enabled entrypoint runs in its own isolate (module instance) on a miss.
const entryIso = await isolate('entry');
const ctx = { waitUntil: (p) => pending.push(p), exports: {} };
const wc = simulatedWorkersCache((req) => new entryIso.Renders({ waitUntil: (p) => pending.push(p) }, env).fetch(req));
ctx.exports.Renders = wc;

const get = async (mod, q) => {
  const before = wc.entries.size;
  const res = await mod.default.fetch(new Request(`https://glyph.example/${q}`), env, ctx);
  const png = new Uint8Array(await res.arrayBuffer());
  await Promise.all(pending.splice(0));
  const d = decodePng(png);
  return { size: png.length, dims: `${d.width}×${d.height}`, etag: res.headers.get('etag').slice(1, 13), wcEntries: wc.entries.size, newWc: wc.entries.size - before };
};
const log = (label, r) => console.log(`${label.padEnd(44)} ${r.dims.padEnd(9)} ${String(r.size).padStart(6)} B  key ${r.etag}…  WC entries ${r.wcEntries}  R2 gets ${r2.gets} puts ${r2.puts}`);

log('isolate 1, ?t=Workers (cold: WC miss → R2 miss → render)', await get(iso1, '?t=Workers'));
log('isolate 1, ?t=Workers again (L1 memory hit)', await get(iso1, '?t=Workers'));
const iso2 = await isolate(2);
log('isolate 2, ?t=Workers (WC hit, no render)', await get(iso2, '?t=Workers'));
wc.purge({ tags: ['glyph'] });
const iso3 = await isolate(3);
log('isolate 3 after purge (WC miss → R2 hit)', await get(iso3, '?t=Workers'));
log('isolate 3, ?t=Edge&s=200 (new content)', await get(iso3, '?t=Edge&s=200'));
if (r2.puts !== 2) { console.error(`expected 2 renders (R2 puts), saw ${r2.puts}`); process.exitCode = 1; }
