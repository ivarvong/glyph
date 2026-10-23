import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { memo, Policy } from '../src/policy.js';
import { layered, origin, memory, store, singleflight, prefetch, mapStore, r2Store, workersCache, serveCached, simulatedWorkersCache } from '../src/layers.js';
import { fsStore } from '../src/node.js';
import { pngJob } from '../src/render.js';
import { loadFont, renderText } from '../../index.js';
import { encodePngBanded } from '../../render/src/stream.js';
import { scanline } from '../../render/src/raster.js';
import { fastZlib } from '../../render/src/png.js';
import { ok, err } from '../../otel-compact/src/adt.js';

const inter = (await loadFont(readFileSync(new URL('../../third_party/fonts/inter-latin-400.woff2', import.meta.url)))).value;
const sceneOf = async (text, size = 32) => (await renderText([{ font: inter, fontKey: 'inter', text, size }], { targets: [] })).value.scene;

/** Unwrap an Ok load (fails the test on Err). */
const val = (r) => { assert.equal(r.tag, 'Ok', r.error); return r.value; };
/** Wrap a job so we can count renders. */
const counted = (job, counter) => ({ ...job, make: () => { counter.n++; return job.make(); } });

test('Node stack: memory → singleflight → filesystem → render; survives a "restart"; bytes equal a direct render', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'glyph-cache-'));
  try {
    const scene = await sceneOf('Cloudflare');
    const renders = { n: 0 };
    const stack = () => {
      const l1 = memory(memo(Policy.Sieve, { maxBytes: 1 << 20 })), fs = store(fsStore(dir));
      return { l1, fs, load: layered(l1, singleflight(), fs)(origin) };
    };
    const a = stack();
    const b1 = val(await a.load(counted(pngJob(scene), renders)));
    const b2 = val(await a.load(counted(pngJob(scene), renders)));
    assert.equal(renders.n, 1); assert.equal(a.l1.stats.hits, 1);
    const fresh = stack(); // new process: empty memory, same directory
    const b3 = val(await fresh.load(counted(pngJob(scene), renders)));
    assert.equal(renders.n, 1, 'served from the filesystem tier'); assert.equal(fresh.fs.stats.hits, 1);
    const direct = await encodePngBanded(scene, scanline, fastZlib);
    for (const b of [b1, b2, b3]) assert.deepEqual(Buffer.from(b), Buffer.from(direct));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('singleflight: 20 concurrent identical misses render once', async () => {
  const scene = await sceneOf('herd');
  const renders = { n: 0 };
  const sf = singleflight();
  const load = layered(sf, store(mapStore()))(origin);
  const out = await Promise.all(Array.from({ length: 20 }, () => load(counted(pngJob(scene), renders))));
  assert.equal(renders.n, 1);
  assert.equal(sf.stats.followers, 19);
  assert.ok(out.every((r) => val(r) === val(out[0])));
});

test('Workers split: isolate memory → Workers Cache → entrypoint (singleflight → R2) → render; purge by tag', async () => {
  // A fake R2 bucket with R2's get/put shape.
  const objects = new Map();
  const bucket = {
    async get(k) { const v = objects.get(k); return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null; },
    async put(k, v) { objects.set(k, new Uint8Array(v)); },
  };
  const renders = { n: 0 };
  const scenes = new Map(); // what the entrypoint can rebuild from a URL
  // Entrypoint side (runs on a Workers Cache miss).
  const r2 = store(r2Store(bucket, { contentType: 'image/png' }));
  const entry = serveCached(layered(singleflight(), r2)(origin), async (req) => {
    const text = new URL(req.url).searchParams.get('t');
    const scene = scenes.get(text) || (await sceneOf(text));
    return counted(pngJob(scene, { meta: { text } }), renders);
  }, { tags: (job) => [`text:${job.meta.text}`] });
  const wc = simulatedWorkersCache(entry);
  // Caller side, two isolates with their own memory.
  const isolate = () => layered(memory(memo(Policy.S3Fifo(0.1), { maxBytes: 1 << 20 })), workersCache(wc, { url: (job) => `https://render/?t=${encodeURIComponent(job.meta.text)}` }))(origin);
  const job = async (text) => pngJob(await sceneOf(text), { meta: { text } });
  const A = isolate(), B = isolate();
  const a1 = val(await A(await job('Workers')));
  const b1 = val(await B(await job('Workers')));
  assert.equal(renders.n, 1, 'second isolate: Workers Cache HIT');
  assert.equal(objects.size, 1, 'R2 written once');
  assert.deepEqual(Buffer.from(a1), Buffer.from(b1));
  wc.purge({ tags: ['text:Workers'] });
  const C = isolate();
  const c1 = val(await C(await job('Workers')));
  assert.equal(renders.n, 1, 'after purge: Workers Cache MISS, served from R2, no render');
  assert.deepEqual(Buffer.from(c1), Buffer.from(a1));
  // The entry the cache holds is keyed by the content key and is immutable.
  const [entryKey] = wc.entries.keys();
  assert.equal(entryKey, (await job('Workers')).key);
  assert.match(wc.entries.get(entryKey).headers.get('cache-control'), /immutable/);
});

test('prefetch: predicted jobs are warmed off the critical path', async () => {
  const pending = [];
  const kv = mapStore();
  const sizes = [24, 32, 48];
  const scenes = await Promise.all(sizes.map((s) => sceneOf('Edge', s)));
  const jobs = scenes.map((sc, i) => pngJob(sc, { meta: { i } }));
  const pf = prefetch((j) => jobs.filter((x) => x.meta.i !== j.meta.i), { defer: (p) => pending.push(p) });
  const load = layered(pf, store(kv))(origin);
  await load(jobs[0]);
  assert.equal(kv.map.size, 1, 'only the requested job is on the critical path');
  await Promise.all(pending);
  assert.equal(kv.map.size, 3, 'the predicted sizes were rendered speculatively');
  assert.equal(pf.stats.issued, 2);
});

test('errors are values: an Err from make propagates, is never cached, and becomes a 502 no-store', async () => {
  const kv = mapStore(), l1 = memory(memo(Policy.Lru, { maxBytes: 1 << 20 }));
  let calls = 0;
  const failing = { key: 'k', make: async () => { calls++; return err('boom'); } };
  const load = layered(l1, singleflight(), store(kv))(origin);
  for (let i = 0; i < 2; i++) assert.deepEqual(await load(failing), err('boom'));
  assert.equal(calls, 2, 'not cached: the second load recomputes');
  assert.equal(kv.map.size, 0);
  const res = await serveCached(load, async () => failing)(new Request('https://x/'));
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), 'boom');
});

test('errors are values: a failing store degrades to a miss; a failing Workers Cache hop falls back to rendering here', async () => {
  const broken = { name: 'broken', get: async () => err('disk on fire'), put: async () => err('disk on fire') };
  const st = store(broken);
  const r = await layered(st)(origin)({ key: 'k', make: async () => ok(new Uint8Array([1, 2, 3])) });
  assert.deepEqual([...val(r)], [1, 2, 3]);
  assert.equal(st.stats.errors, 2, 'one failed get, one failed put, both counted');
  const local = { key: 'k', make: async () => ok(new Uint8Array([9, 9])) };
  for (const ep of [
    { fetch: async () => new Response('nope', { status: 503 }) },
    { fetch: async () => { throw new TypeError('network'); } },
  ]) {
    const wc = workersCache(ep, { url: () => 'https://r/' });
    assert.deepEqual([...val(await layered(wc)(origin)(local))], [9, 9], 'rendered locally');
    assert.equal(wc.stats.fallbacks, 1); assert.equal(wc.stats.errors, 1);
  }
});

test('integrity: a corrupt stored value is a miss and is rewritten; corrupt bytes across the Workers Cache hop are not served', async () => {
  const kv = mapStore();
  const st = store(kv);
  let renders = 0;
  const job = { key: 'k', make: async () => { renders++; return ok(new Uint8Array([1, 2, 3, 4])); } };
  const load = layered(st)(origin);
  await load(job);
  const stored = kv.map.get('k');
  stored[stored.length - 1] ^= 0xff; // bit rot in the payload
  assert.deepEqual([...val(await load(job))], [1, 2, 3, 4], 'served the fresh render, not the rot');
  assert.equal(st.stats.corrupt, 1); assert.equal(renders, 2);
  assert.deepEqual([...val(await load(job))], [1, 2, 3, 4]);
  assert.equal(renders, 2, 'the rewritten value verifies');
  // Across the hop: serveCached adds x-content-sha256; a body that does not match is not served.
  const good = serveCached(layered()(origin), async () => ({ key: 'k', make: async () => ok(new Uint8Array([5, 6, 7])) }));
  const flipping = { fetch: async (req) => { const res = await good(req); const b = new Uint8Array(await res.arrayBuffer()); b[0] ^= 1; return new Response(b, res); } };
  const wc = workersCache(flipping, { url: () => 'https://r/' });
  const r = await layered(wc)(origin)({ key: 'k', make: async () => ok(new Uint8Array([5, 6, 7])) });
  assert.deepEqual([...val(r)], [5, 6, 7]);
  assert.equal(wc.stats.corrupt, 1); assert.equal(wc.stats.fallbacks, 1);
  const honest = workersCache({ fetch: (req) => good(req) }, { url: () => 'https://r/' });
  assert.deepEqual([...val(await layered(honest)(origin)({ key: 'k', make: async () => ok(new Uint8Array([0])) }))], [5, 6, 7], 'verified bytes from the hop are used');
  assert.equal(honest.stats.fallbacks, 0);
});
