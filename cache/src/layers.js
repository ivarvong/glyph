// @ts-check
// Cache tiers as function composition. Runtime-agnostic: nothing here needs Workers.
//
//   Loader = (job) => Promise<Result<Uint8Array, string>>    job = { key, make, meta?, span? }
//   Layer  = (inner: Loader) => Loader
//
//   const load = layered(memory(memo(Policy.Sieve, …)), singleflight(), store(fsStore(dir)))(origin);
//   const png  = await load({ key: sceneKey(scene, cfg), make: async () => ok(render(scene)) });
//
// Errors are values end to end: an Err is never cached, a failing store tier is a counted miss,
// and serveCached turns an Err into a 502 with no-store.
//
// `make` computes the value on a miss at the bottom (`origin`). `meta` is what a tier on the
// other side of a hop needs to recompute it there (Workers Cache: the request to re-render).
// Each layer carries `.stats` ({ hits, misses, … }) and records a `cache.<name>` span.
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { some, NONE, option, ok, err } from '../../otel-compact/src/adt.js';
import { sha256, hex } from './key.js';

/**
 * SHA-256 hex of bytes: the platform's native digest where there is one (Workers, Node,
 * browsers), else the pure-JS one. Used to verify bytes that crossed a tier.
 * @param {Uint8Array} b @returns {Promise<string>}
 */
export const digest = async (b) => {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) return hex(new Uint8Array(await subtle.digest('SHA-256', /** @type {BufferSource} */ (/** @type {unknown} */ (b)))));
  return hex(sha256(b));
};

// Stored values are framed: 'GLY1' + SHA-256 of the payload + payload. A value that fails the
// check (bit rot, a truncated write, another writer's bytes) is a counted miss, never served.
const MAGIC = [0x47, 0x4c, 0x59, 0x31];
/** @param {Uint8Array} b */
export const frame = async (b) => {
  const d = await digest(b);
  const out = new Uint8Array(36 + b.length);
  out.set(MAGIC); for (let i = 0; i < 32; i++) out[4 + i] = parseInt(d.slice(2 * i, 2 * i + 2), 16);
  out.set(b, 36);
  return out;
};
/** @param {Uint8Array} f @returns {Promise<import('../../otel-compact/src/adt.js').Option<Uint8Array>>} */
export const unframe = async (f) => {
  if (f.length < 36 || MAGIC.some((m, i) => f[i] !== m)) return NONE;
  const b = f.subarray(36);
  return hex(f.subarray(4, 36)) === (await digest(b)) ? some(b) : NONE;
};

/**
 * @typedef {object} Job
 * @property {string} key                        content key (see key.js)
 * @property {() => Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>} make  compute on a miss
 * @property {Record<string, any>} [meta]         for tiers across a hop (e.g. a request URL)
 * @property {import('../../otel-compact/src/trace.js').Span} [span]
 * @property {(p: Promise<unknown>) => void} [defer]   this request's background hook (Workers: ctx.waitUntil)
 */
/** Errors are values: a load is Ok(bytes) or Err(reason); no layer throws. */
/** @typedef {(job: Job) => Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>} Loader */
/** @typedef {((inner: Loader) => Loader) & { stats: Record<string, number>, layerName: string }} Layer */

/** The bottom of every stack: compute. @type {Loader} */
export const origin = (job) => job.make();

/** Compose layers outermost first: layered(L1, L2, L3)(origin). @param {...Layer} layers */
export const layered = (...layers) => (/** @type {Loader} */ bottom) => layers.reduceRight((inner, l) => l(inner), bottom);

/**
 * @param {string} name @param {Record<string, number>} stats
 * @param {(inner: Loader) => Loader} f @returns {Layer}
 */
const layer = (name, stats, f) => Object.assign(f, { stats, layerName: name });

/**
 * Run `fn` in a span named cache.<name> with `hit` and `bytes` attributes (or the error).
 * @param {Job} job @param {string} name
 * @param {(s: any) => Promise<import('../../otel-compact/src/adt.js').Result<[Uint8Array, boolean], string>>} fn
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>}
 */
const traced = async (job, name, fn) => (job.span || NOOP_SPAN).span(`cache.${name}`, async (s) => {
  const r = await fn(s);
  if (r.tag === 'Err') { s.fail(r.error); return r; }
  if (s.recording) { s.set('hit', r.value[1]); s.set('bytes', r.value[0].length); }
  return ok(r.value[0]);
});
/** @param {Uint8Array} b @param {boolean} hit */
const served = (b, hit) => ok(/** @type {[Uint8Array, boolean]} */ ([b, hit]));

/**
 * L1: in-process memo (any Policy from policy.js), sized by bytes. Errors are not cached.
 * @param {import('./policy.js').Memo<Uint8Array>} m
 */
export const memory = (m) => {
  const stats = { hits: 0, misses: 0 };
  return layer(`memory.${m.name}`, stats, (inner) => (job) => traced(job, `memory.${m.name}`, async (s) => {
    const v = m.get(job.key);
    if (v.tag === 'Some') { stats.hits++; return served(v.value, true); }
    stats.misses++;
    const r = await inner({ ...job, span: s });
    if (r.tag === 'Err') return r;
    m.set(job.key, r.value, r.value.length);
    return served(r.value, false);
  }));
};

/**
 * @typedef {object} Store   an async byte KV: R2, a filesystem, a Map, anything with get/put.
 *   Errors are values: an I/O failure is Err, absence is Ok(NONE).
 * @property {string} name
 * @property {(key: string) => Promise<import('../../otel-compact/src/adt.js').Result<import('../../otel-compact/src/adt.js').Option<Uint8Array>, string>>} get
 * @property {(key: string, bytes: Uint8Array) => Promise<import('../../otel-compact/src/adt.js').Result<true, string>>} put
 */

/**
 * Read-through over a Store. A failing tier degrades to a miss (render, don't fail the request)
 * and is counted. Writes go through the job's `defer` (else this layer's), e.g. Workers
 * ctx.waitUntil, so a miss does not wait for the write; with neither, it awaits it.
 * Values are framed with a SHA-256 and checked on read (`verify`, default on): a corrupt value
 * is a counted miss (`stats.corrupt`) and is overwritten by the fresh render (chaos: r2-corrupt).
 * @param {Store} kv @param {{ defer?: (p: Promise<unknown>) => void, verify?: boolean }} [opts]
 */
export const store = (kv, { defer, verify = true } = {}) => {
  const stats = { hits: 0, misses: 0, writes: 0, errors: 0, corrupt: 0 };
  return layer(`store.${kv.name}`, stats, (inner) => (job) => traced(job, `store.${kv.name}`, async (s) => {
    const v = await kv.get(job.key);
    if (v.tag === 'Err') stats.errors++;
    else if (v.value.tag === 'Some') {
      const b = verify ? await unframe(v.value.value) : v.value;
      if (b.tag === 'Some') { stats.hits++; return served(b.value, true); }
      stats.corrupt++;
    }
    stats.misses++;
    const r = await inner({ ...job, span: s });
    if (r.tag === 'Err') return r;
    const w = (verify ? frame(r.value) : Promise.resolve(r.value)).then((f) => kv.put(job.key, f))
      .then((p) => { if (p.tag === 'Ok') stats.writes++; else stats.errors++; });
    const later = job.defer || defer;
    if (later) later(w); else await w;
    return served(r.value, false);
  }));
};

/** Coalesce concurrent loads of one key into one inner call (a thundering herd costs one render). */
export const singleflight = () => {
  const stats = { leaders: 0, followers: 0 };
  /** @type {Map<string, ReturnType<Loader>>} */
  const inflight = new Map();
  return layer('singleflight', stats, (inner) => (job) => {
    const p = inflight.get(job.key);
    if (p) { stats.followers++; return p; }
    stats.leaders++;
    const q = inner(job).then((r) => { inflight.delete(job.key); return r; });
    inflight.set(job.key, q);
    return q;
  });
};

/**
 * Speculative: after serving a job, load the jobs `predict` returns, off the critical path
 * (`defer`: Workers ctx.waitUntil, or fire-and-forget). Put it above the tiers it should warm.
 * @param {(job: Job) => Job[]} predict @param {{ defer: (p: Promise<unknown>) => void, limit?: number }} opts
 */
export const prefetch = (predict, { defer, limit = 4 }) => {
  const stats = { issued: 0, failed: 0 };
  return layer('prefetch', stats, (inner) => async (job) => {
    const r = await inner(job);
    for (const next of predict(job).slice(0, limit)) {
      stats.issued++;
      defer(inner({ ...next, span: NOOP_SPAN }).then((x) => { if (x.tag === 'Err') stats.failed++; }));
    }
    return r;
  });
};

// ---- stores --------------------------------------------------------------------------------

/** In-memory Store (tests, simulators, or a process-local L2). @param {string} [name] @returns {Store & { map: Map<string, Uint8Array> }} */
export function mapStore(name = 'map') {
  /** @type {Map<string, Uint8Array>} */
  const map = new Map();
  return { name, map, get: async (k) => ok(option(map.get(k))), put: async (k, b) => { map.set(k, b); return ok(/** @type {const} */ (true)); } };
}

/**
 * R2 bucket binding as a Store. Uses only R2's get/put; works with any object that has them.
 * @param {{ get(k: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>, put(k: string, v: Uint8Array, o?: object): Promise<unknown> }} bucket
 * @param {{ prefix?: string, contentType?: string }} [opts]
 * @returns {Store}
 */
export function r2Store(bucket, { prefix = 'glyph/', contentType = 'application/octet-stream' } = {}) {
  return {
    name: 'r2',
    // Platform edge: binding calls reject on network or service errors; they become values here.
    async get(k) {
      try { const o = await bucket.get(prefix + k); return ok(o ? some(new Uint8Array(await o.arrayBuffer())) : NONE); }
      catch (e) { return err(`r2 get: ${e instanceof Error ? e.message : String(e)}`); }
    },
    async put(k, b) {
      try { await bucket.put(prefix + k, b, { httpMetadata: { contentType } }); return ok(/** @type {const} */ (true)); }
      catch (e) { return err(`r2 put: ${e instanceof Error ? e.message : String(e)}`); }
    },
  };
}

// ---- Workers Cache --------------------------------------------------------------------------
// Workers Cache sits in front of a Worker's own entrypoints and is read-through: the caller
// asks a cache-enabled entrypoint (ctx.exports.X.fetch) with `cf.cacheKey`; on a miss the
// entrypoint runs and its response is cached per Cache-Control, tagged by Cache-Tag. So the
// stack is split across the hop: the caller's layers above, the entrypoint's layers below.

/**
 * Caller side: a Layer whose work normally happens in the entrypoint (it recomputes from
 * `meta`). If the hop fails — rejects, answers non-OK, or returns bytes that fail the
 * `x-content-sha256` check that `serveCached` adds — the layer degrades to `inner` (render here)
 * instead of failing the request, and counts it (chaos: wc-down, wc-corrupt).
 * @param {{ fetch(req: Request, init?: { cf?: { cacheKey?: string } }): Promise<Response> }} entrypoint  ctx.exports.Renders
 * @param {{ url: (job: Job) => string, verify?: boolean }} opts  how to address the work, e.g. job => `https://render/${job.meta.query}`
 */
export const workersCache = (entrypoint, { url, verify = true }) => {
  const stats = { calls: 0, hits: 0, misses: 0, errors: 0, corrupt: 0, fallbacks: 0 };
  return layer('workers-cache', stats, (inner) => (job) => traced(job, 'workers-cache', async (s) => {
    stats.calls++;
    const hop = await fromHop(entrypoint, url(job), job.key);
    if (hop.tag === 'Ok') {
      const { bytes, hit, sha } = hop.value;
      if (!verify || (sha !== '' && sha === (await digest(bytes)))) {
        if (hit) stats.hits++; else stats.misses++;
        return served(bytes, hit);
      }
      stats.corrupt++;
    } else stats.errors++;
    stats.fallbacks++;
    if (s.recording) s.set('fallback', hop.tag === 'Ok' ? 'integrity' : hop.error);
    const r = await inner({ ...job, span: s });
    return r.tag === 'Ok' ? served(r.value, false) : r;
  }));
};

/**
 * One call across the Workers Cache hop, as a value. Platform edge: fetch can reject.
 * @param {any} entrypoint @param {string} u @param {string} key
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<{ bytes: Uint8Array, hit: boolean, sha: string }, string>>}
 */
async function fromHop(entrypoint, u, key) {
  try {
    const res = await entrypoint.fetch(new Request(u), { cf: { cacheKey: key } });
    if (!res.ok) return err(`workers-cache: entrypoint returned ${res.status}`);
    return ok({ bytes: new Uint8Array(await res.arrayBuffer()), hit: res.headers.get('cf-cache-status') === 'HIT', sha: res.headers.get('x-content-sha256') || '' });
  } catch (e) {
    return err(`workers-cache: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Entrypoint side: turn a request into a job, run it through this side's loader, and answer
 * with caching headers. `tags` become Cache-Tag for ctx.cache.purge({ tags }).
 * @param {Loader} load @param {(req: Request) => Job | Promise<Job>} toJob
 * @param {{ maxAge?: number, swr?: number, contentType?: string, tags?: (job: Job) => string[] }} [opts]
 */
export const serveCached = (load, toJob, { maxAge = 31536000, swr = 0, contentType = 'image/png', tags = () => [] } = {}) =>
  async (/** @type {Request} */ req) => {
    const job = await toJob(req);
    const r = await load(job);
    // An Err must not be cached: answer 502 with no-store, so the next request recomputes.
    if (r.tag === 'Err') return new Response(r.error, { status: 502, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' } });
    const bytes = r.value;
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': contentType,
      // Content-addressed: the key changes when the bytes would, so entries never go stale.
      'cache-control': `public, max-age=${maxAge}${swr ? `, stale-while-revalidate=${swr}` : ''}, immutable`,
      etag: `"${job.key}"`,
      // The caller's workersCache layer checks the bytes against this after the hop.
      'x-content-sha256': await digest(bytes),
    };
    const t = tags(job);
    if (t.length) headers['cache-tag'] = t.join(',');
    return new Response(/** @type {BodyInit} */ (/** @type {unknown} */ (bytes)), { headers });
  };

/**
 * A stand-in for Workers Cache in front of an entrypoint, for Node and tests: keyed by
 * cf.cacheKey (else path + query), honours Cache-Control max-age and `private`/`no-store`,
 * records Cache-Tag, answers cf-cache-status HIT/MISS, and supports purge({ tags }).
 * It models the documented behaviour; it is not the production cache.
 * @param {(req: Request) => Promise<Response>} handler @param {{ now?: () => number }} [opts]
 */
export function simulatedWorkersCache(handler, { now = () => Date.now() } = {}) {
  /** @type {Map<string, { body: Uint8Array, headers: Headers, expires: number, tags: string[] }>} */
  const entries = new Map();
  return {
    entries,
    /** @param {Request} req @param {{ cf?: { cacheKey?: string } }} [init] */
    async fetch(req, init = {}) {
      const u = new URL(req.url);
      const key = (init.cf && init.cf.cacheKey) || u.pathname + u.search;
      const e = entries.get(key);
      if (e && e.expires > now()) {
        const h = new Headers(e.headers); h.set('cf-cache-status', 'HIT');
        return new Response(/** @type {BodyInit} */ (/** @type {unknown} */ (e.body.slice())), { headers: h });
      }
      const res = await handler(req);
      const cc = res.headers.get('cache-control') || '';
      const body = new Uint8Array(await res.arrayBuffer());
      const m = /max-age=(\d+)/.exec(cc);
      const maxAge = m ? Number(m[1]) : 0;
      if (res.ok && maxAge > 0 && !/private|no-store/.test(cc)) {
        entries.set(key, { body, headers: res.headers, expires: now() + maxAge * 1000, tags: (res.headers.get('cache-tag') || '').split(',').filter(Boolean) });
      }
      const h = new Headers(res.headers); h.set('cf-cache-status', 'MISS');
      return new Response(/** @type {BodyInit} */ (/** @type {unknown} */ (body)), { status: res.status, headers: h });
    },
    /** @param {{ tags?: string[], purgeEverything?: boolean }} o */
    purge({ tags = [], purgeEverything = false }) {
      for (const [k, e] of entries) if (purgeEverything || e.tags.some((t) => tags.includes(t))) entries.delete(k);
    },
  };
}
