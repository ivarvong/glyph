// Execute examples/worker-fetch.ts as written, in Node, with an R2-shaped bucket, ctx.waitUntil,
// and a stand-in network (globalThis.fetch) serving fixtures, junk, and a hostile-metrics font.
//   node --experimental-strip-types --no-warnings examples/worker-fetch-check.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { decodePng } from '../verify/pngdecode.js';

const src = readFileSync(new URL('./worker-fetch.ts', import.meta.url), 'utf8');
mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
const file = new URL('../out/worker-fetch-run.ts', import.meta.url);
writeFileSync(file, src);

const fixture = (f) => new Uint8Array(readFileSync(new URL(f, import.meta.url)));
const net = {
  'https://fonts.gstatic.com/inter.woff2': () => new Response(fixture('../third_party/fonts/inter-latin-400.woff2')),
  'https://cdn.jsdelivr.net/serif.woff2': () => new Response(null, { status: 302, headers: { location: 'https://fonts.gstatic.com/serif.woff2' } }),
  'https://fonts.gstatic.com/serif.woff2': () => new Response(fixture('../third_party/fonts/source-serif-4-regular.otf.woff2')),
  'https://fonts.gstatic.com/junk.woff2': () => new Response(new Uint8Array(4096).fill(0x42)),
  'https://fonts.gstatic.com/hostile.woff2': () => new Response(fixture('../third_party/fuzz/slow-tiny-upem-35d6d4188c01.bin')),
};
const fetched = [];
globalThis.fetch = async (url) => { fetched.push(url); const r = net[url]; if (!r) throw new TypeError('fetch failed'); return r(); };

const objects = new Map();
const env = { FONTS: {
  async get(k) { const v = objects.get(k); return v ? { arrayBuffer: async () => v.slice().buffer } : null; },
  async put(k, v) { objects.set(k, new Uint8Array(v)); },
} };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
let failed = 0;
const get = async (iso, q, want) => {
  const n0 = fetched.length;
  const res = await iso.default.fetch(new Request(`https://glyph.example/?${q}`), env, ctx);
  await Promise.all(pending.splice(0));
  const body = new Uint8Array(await res.arrayBuffer());
  const what = res.status === 200 ? (({ width, height }) => `${width}×${height} PNG ${body.length} B`)(decodePng(body)) : new TextDecoder().decode(body).slice(0, 90);
  const ok = res.status === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(res.status)} ${q.padEnd(58)} net ${fetched.length - n0}  ${what}`);
};
const iso1 = await import(`${file.href}?isolate=1`);
await get(iso1, 'font=https://fonts.gstatic.com/inter.woff2&t=Workers', 200);
await get(iso1, 'font=https://fonts.gstatic.com/inter.woff2&t=again (memory)', 200);
await get(iso1, 'font=https://cdn.jsdelivr.net/serif.woff2&t=via redirect', 200);
await get(iso1, 'font=https://evil.example/x.woff2', 422);
await get(iso1, 'font=http://fonts.gstatic.com/inter.woff2', 422);
await get(iso1, 'font=https://cdn.jsdelivr.net/missing.woff2', 502); // network failure: upstream, retryable
await get(iso1, 'font=https://fonts.gstatic.com/junk.woff2', 422);
await get(iso1, 'font=https://fonts.gstatic.com/hostile.woff2&s=24&t=Hfiffl%20AVTo%200123%20office', 413);
const iso2 = await import(`${file.href}?isolate=2`);
await get(iso2, 'font=https://fonts.gstatic.com/inter.woff2&t=isolate 2 (R2)', 200);
if (failed) { console.error(`${failed} unexpected status code(s)`); process.exitCode = 1; }
