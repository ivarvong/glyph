// @ts-check
// A generic renderer of scene specs: no fonts, no scenes, no configuration of its own. Everything
// it draws arrives in the request: the spec (by URL, inline, as a POST body, or by the id of a
// stored spec), which names its fonts by URL; a device pixel ratio; values for the spec's params.
//
//   GET  /render?spec=<https URL>[&sha256=<hex>]&dpr=1..4&format=png|svg[&p.<name>=<text>…]
//   GET  /render?s=<URL-encoded JSON | base64url JSON | z<base64url deflate-raw JSON>>&…
//        e.g. /render?s=%7B%22glyph%22%3A1%2C%22size%22%3A%5B64%2C64%5D%2C%22items%22%3A%5B%5D%7D&dpr=1
//   GET  /render?id=<sha256 hex of a stored spec>&…
//   POST /render?dpr=…   (body: the spec JSON)
//   POST /specs          (body: the spec JSON) → 201 (200 if already stored) { id, bytes, render, svg }
//   GET  /specs/<id>     the stored spec JSON, to fork
//
// Stored specs (an R2 bucket, SPECS; without it these answer 501) are validated by parseSpec,
// capped at storeBytes, and content-addressed: the key is the SHA-256 of the exact bytes, so an
// upload is immutable, identical uploads dedupe, and a load is checked against its id.
//
// Caching is layered and content-addressed (cache/src/layers.js), per isolate unless noted:
//   specs     by URL: Workers Cache, 60 s (or immutable when pinned by sha256)
//   fonts     bytes by URL through Workers Cache; parsed fonts by content in an LRU sized by
//             fontCost (a measured bound); glyph outlines flattened once, by content + transform
//   renders   key = SHA-256(version, spec bytes, dpr, format, params): small ones in memory
//             (Sieve) → Workers Cache → R2 (when bound) → render, streamed
// Memory: every cache has a byte budget, and a render streams: geometry is built band by band
// (render/src/stream.js) and the PNG goes to the client as it is encoded. Concurrency is the
// platform's to schedule; this code does not queue or refuse.
//
// Errors are values all the way to the response: each failure is a typed Problem with a status.

import { ok, err } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { memo, Policy } from '../../cache/src/policy.js';
import { layered, origin, r2Store, workersCache, serveCached, digest, frame, unframe } from '../../cache/src/layers.js';
import { fetchBytes, fetchFont, publicHttps, describe, fontCost } from '../../net/src/fetch.js';
import { flattenCache, scanline } from '../../render/src/raster.js';
import { balancedZlib } from '../../render/src/png.js';
import { pngStream } from '../../render/src/stream.js';
import { toSvg } from '../../render/src/svg.js';
import { buildScene, parseSpec, SPEC_LIMITS } from '../../spec/src/spec.js';

export const VERSION = 'glyph-render/1';

/** Budgets, all overridable by the host (none are required). */
export const DEFAULTS = Object.freeze({
  specBytes: 16 << 20,     // largest spec accepted (the 22k-item poster is 1.8 MB)
  inlineChars: 12_000,     // `s=` query parameter
  storeBytes: 4 << 20,     // largest spec POST /specs stores
  fontBytes: 16 << 20,
  fetchMs: 10_000,
  fontsBytes: 32 << 20,    // parsed-font cache, sized by fontCost
  outlinesBytes: 8 << 20,  // flattened glyph cache
  rendersBytes: 16 << 20,  // L1 PNG cache
  maxPixels: 1 << 25,
});

/**
 * @typedef {{ status: number, error: string, detail: unknown }} Problem
 * @typedef {{ kind: 'url', url: string, sha256: string } | { kind: 'bytes', bytes: Uint8Array, origin: 'inline' | 'body' } | { kind: 'id', id: string }} Source
 * @typedef {{ source: Source, dpr: number, format: 'png' | 'svg', params: Record<string, string> }} RenderReq
 */

/** @param {number} status @param {string} error @param {unknown} detail @returns {Problem} */
const problem = (status, error, detail) => ({ status, error, detail });
const ID = /^[0-9a-f]{64}$/;

/** base64url → bytes; null when malformed. @param {string} s */
function fromBase64url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** deflate-raw → bytes, capped. @param {Uint8Array} z @param {number} max */
async function inflateRaw(z, max) {
  try {
    const r = new Response(new Blob([/** @type {BlobPart} */ (/** @type {unknown} */ (z))]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).body;
    if (!r) return err('empty');
    const reader = r.getReader();
    const parts = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { reader.cancel(); return err(`inflates past ${max} bytes`); }
      parts.push(value);
    }
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return ok(out);
  } catch (e) { return err(e instanceof Error ? e.message : String(e)); } // platform edge: a corrupt stream rejects
}

/**
 * Parse the request into what to render. Every input is bounded and checked.
 * @param {Request} req @param {typeof DEFAULTS} lim
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<RenderReq, Problem>>}
 */
export async function parseRequest(req, lim) {
  const u = new URL(req.url);
  const q = u.searchParams;
  const dpr = q.has('dpr') ? Number(q.get('dpr')) : 1;
  if (!(dpr > 0 && dpr <= 4)) return err(problem(400, 'request', { at: '?dpr', expected: 'a number in (0, 4]', found: q.get('dpr') }));
  const format = q.get('format') || 'png';
  if (format !== 'png' && format !== 'svg') return err(problem(400, 'request', { at: '?format', expected: 'png | svg', found: format }));
  /** @type {Record<string, string>} */
  const params = {};
  for (const [k, v] of q) if (k.startsWith('p.')) params[k.slice(2)] = v;
  if (Object.keys(params).length > SPEC_LIMITS.params) return err(problem(400, 'request', { at: '?p.*', expected: `at most ${SPEC_LIMITS.params} params`, found: Object.keys(params).length }));
  /** @type {Source} */
  let source;
  if (req.method === 'POST') {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > lim.specBytes) return err(problem(413, 'request', { at: 'body', expected: `at most ${lim.specBytes} bytes`, found: len }));
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > lim.specBytes) return err(problem(413, 'request', { at: 'body', expected: `at most ${lim.specBytes} bytes`, found: body.length }));
    source = { kind: 'bytes', bytes: body, origin: 'body' };
  } else if (q.has('s')) {
    const s = /** @type {string} */ (q.get('s'));
    if (s.length > lim.inlineChars) return err(problem(414, 'request', { at: '?s', expected: `at most ${lim.inlineChars} characters`, found: s.length }));
    // JSON text as is (base64url never contains `{`), else base64url, or z + base64url deflate-raw.
    const text = /^\s*\{/.test(s) ? new TextEncoder().encode(s) : null;
    if (text && text.length > lim.inlineChars) return err(problem(414, 'request', { at: '?s', expected: `at most ${lim.inlineChars} bytes`, found: text.length }));
    const z = !text && s.startsWith('z');
    const raw = text || fromBase64url(z ? s.slice(1) : s);
    if (!raw) return err(problem(400, 'request', { at: '?s', expected: 'URL-encoded JSON, base64url JSON, or z + base64url deflate-raw JSON', found: s.slice(0, 40) }));
    const bytes = z ? await inflateRaw(raw, lim.specBytes) : ok(raw);
    if (bytes.tag === 'Err') return err(problem(400, 'request', { at: '?s', expected: 'deflate-raw data', found: bytes.error }));
    source = { kind: 'bytes', bytes: bytes.value, origin: 'inline' };
  } else if (q.has('id')) {
    const id = /** @type {string} */ (q.get('id'));
    if (!ID.test(id)) return err(problem(400, 'request', { at: '?id', expected: '64 lowercase hex digits', found: id.slice(0, 80) }));
    source = { kind: 'id', id };
  } else if (q.has('spec')) {
    const url = /** @type {string} */ (q.get('spec'));
    const sha = q.get('sha256') || '';
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) return err(problem(400, 'request', { at: '?sha256', expected: '64 lowercase hex digits', found: sha }));
    source = { kind: 'url', url, sha256: sha };
  } else {
    return err(problem(400, 'request', { at: '?spec', expected: 'spec=<https URL>, s=<inline spec>, id=<stored spec>, or a POST body', found: u.search }));
  }
  return ok({ source, dpr, format, params });
}

/** The query that names a URL- or id-sourced render, canonically ordered: the Workers Cache hop's address. @param {RenderReq} r */
export function canonicalQuery(r) {
  const q = new URLSearchParams();
  if (r.source.kind === 'url') { q.set('spec', r.source.url); if (r.source.sha256) q.set('sha256', r.source.sha256); }
  if (r.source.kind === 'id') q.set('id', r.source.id);
  q.set('dpr', String(r.dpr)); q.set('format', r.format);
  for (const k of Object.keys(r.params).sort()) q.set(`p.${k}`, r.params[k]);
  return q.toString();
}

/**
 * The renderer: isolate-level caches and gate, and the handlers. `platform` is everything that
 * differs between Workers, the simulator and Node: fetch, the Workers Cache entrypoint (or none),
 * an R2-shaped bucket (or none), the background hook.
 * @param {Partial<typeof DEFAULTS>} [overrides]
 */
export function createRenderer(overrides = {}) {
  const lim = { ...DEFAULTS, ...overrides };
  const fonts = memo(Policy.Lru, { maxBytes: lim.fontsBytes });
  const outlines = flattenCache({ maxBytes: lim.outlinesBytes });
  const renders = memo(Policy.Sieve, { maxBytes: lim.rendersBytes });

  /**
   * @typedef {object} Platform
   * @property {(input: string, init?: RequestInit) => Promise<Response>} fetch
   * @property {{ fetch(req: Request, init?: { cf?: { cacheKey?: string } }): Promise<Response> } | null} cached  the cache-enabled entrypoint
   * @property {any} bucket   R2 binding, or null
   * @property {any} specs    R2 binding for stored specs (POST /specs, ?id=), or null
   * @property {(p: Promise<unknown>) => void} defer
   * @property {import('../../otel-compact/src/trace.js').Tracer} tracer  NOOP_TRACER unless tracing
   */

  /**
   * A stored spec by id, checked against it: 501 without a SPECS bucket, 404 when unknown.
   * @param {string} id @param {Platform} pf
   * @returns {Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, Problem>>}
   */
  const storedSpec = async (id, pf) => {
    if (!pf.specs) return err(NO_STORE);
    const g = await specStore(pf.specs).get(id);
    if (g.tag === 'Err') return err(problem(502, 'store', g.error));
    if (g.value.tag === 'None') return err(problem(404, 'spec', { at: '?id', expected: 'the id of a stored spec', found: id }));
    if ((await digest(g.value.value)) !== id) return err(problem(502, 'store', `spec ${id}: sha256 does not match`));
    return ok(g.value.value);
  };

  /** Spec bytes for a source: by URL through Workers Cache when there is one. @param {Source} s @param {Platform} pf @param {import('../../otel-compact/src/trace.js').Span} [span] */
  const specBytes = async (s, pf, span = NOOP_SPAN) => {
    if (s.kind === 'bytes') return ok(s.bytes);
    if (s.kind === 'id') return storedSpec(s.id, pf);
    const job = { key: `spec:${await digest(new TextEncoder().encode(`${s.url}\n${s.sha256}`))}`, meta: { url: s.url, sha256: s.sha256 }, span, make: () => fetchSpec(s, pf) };
    const load = pf.cached ? layered(workersCache(pf.cached, { url: (j) => `https://glyph.internal/spec?${new URLSearchParams(/** @type {any} */ (j.meta))}` }))(origin) : origin;
    const r = await load(job);
    // The client's fault (a refused URL, an oversized spec) is a 4xx; the origin's is a 502.
    if (r.tag === 'Err') return err(problem(/^refused /.test(r.error) ? 400 : / is over \d+ bytes$/.test(r.error) ? 413 : 502, 'spec', r.error));
    return ok(r.value);
  };
  /** @param {{ url: string, sha256: string }} s @param {Platform} pf */
  const fetchSpec = async (s, pf) => {
    const r = await fetchBytes(s.url, { fetch: pf.fetch, policy: publicHttps, maxBytes: lim.specBytes, timeoutMs: lim.fetchMs });
    if (r.tag === 'Err') return err(describe(r.error));
    if (s.sha256 && (await digest(r.value.bytes)) !== s.sha256) return err(`spec ${s.url}: sha256 does not match`);
    return ok(r.value.bytes);
  };

  /** Load one font for a spec: bytes through Workers Cache, parsed once per content. @param {Platform} pf @param {import('../../otel-compact/src/trace.js').Span} [span] */
  const fontLoader = (pf, span = NOOP_SPAN) => async (/** @type {import('../../spec/src/spec.js').FontRef} */ ref) => span.span('font', { url: ref.url }, async (fs) => {
    const base = { fetch: pf.fetch, policy: publicHttps, maxBytes: lim.fontBytes, timeoutMs: lim.fetchMs, fonts, defer: pf.defer, span: fs };
    const r = await fetchFont(ref.url, pf.cached
      ? { ...base, via: layered(workersCache(pf.cached, { url: () => `https://glyph.internal/font?${new URLSearchParams({ url: ref.url })}` }))(origin) }
      : base);
    if (r.tag === 'Err') return err(r.error);
    if (ref.sha256 && r.value.key !== ref.sha256) return err({ tag: 'Integrity', url: ref.url, expected: ref.sha256, found: r.value.key });
    if (fs.recording) fs.set('bytes', r.value.bytes.length);
    return ok({ font: r.value.font, key: r.value.key.slice(0, 16) });
  });

  const contentType = (/** @type {string} */ f) => (f === 'svg' ? 'image/svg+xml' : 'image/png');
  const L1_MAX = 512 << 10; // L1 keeps small renders only; large ones live in Workers Cache and R2
  const bucketOf = (/** @type {Platform} */ pf) => (pf.bucket ? r2Store(pf.bucket, { prefix: 'glyph-render/' }) : null);

  /** Content key of a render: version, spec bytes, dpr, format, params. @param {RenderReq} rq @param {Uint8Array} spec */
  const renderKey = async (rq, spec) => `render-${await digest(new TextEncoder().encode(
    [VERSION, await digest(spec), rq.dpr, rq.format, canonicalQuery({ ...rq, source: { kind: 'bytes', bytes: new Uint8Array(0), origin: 'body' } })].join('\n')))}`;

  /** Spec bytes → scene (fonts loaded, compiled), or the problem. @param {RenderReq} rq @param {Uint8Array} spec @param {Platform} pf @param {import('../../otel-compact/src/trace.js').Span} [span] */
  const sceneFor = async (rq, spec, pf, span = NOOP_SPAN) => {
    const json = parseJson(spec, span);
    if (json.tag === 'Err') return json;
    const built = await span.span('scene.build', (bs) => buildScene(json.value, { dpr: rq.dpr, params: rq.params, loadFont: fontLoader(pf, bs), maxPixels: lim.maxPixels }));
    if (span.recording && built.tag === 'Ok') { span.set('items', built.value.scene.items.length); span.set('pixels', built.value.scene.width * built.value.scene.height); }
    if (built.tag === 'Err') {
      const e = built.error;
      return err(e.tag === 'Spec' ? problem(400, 'spec', e.errors) : problem(502, 'font', { name: e.name, url: e.url, error: e.error }));
    }
    return ok(built.value.scene);
  };

  const streamStats = { streamed: 0, r2Hits: 0, r2Puts: 0, cancelled: 0 };

  /**
   * The bottom of the stack: R2 (verified), else a new render. A PNG render is *streamed*: the
   * response body is the band-by-band encoder itself, so the runtime pulls bands as the network
   * drains (backpressure; the isolate yields between bands; no full-image buffer for the client).
   * Emitted chunks are kept by reference for one framed R2 write (and L1, when small).
   * @param {RenderReq} rq @param {Uint8Array} spec @param {string} key @param {Platform} pf @param {Record<string, string>} headers
   * @param {import('../../otel-compact/src/trace.js').Span} [span]
   * @returns {Promise<Response>}
   */
  const produce = async (rq, spec, key, pf, headers, span = NOOP_SPAN) => {
    const bucket = bucketOf(pf);
    const bytesResponse = async (/** @type {Uint8Array} */ b) => new Response(/** @type {BodyInit} */ (/** @type {unknown} */ (b)), { headers: { ...headers, 'x-content-sha256': await digest(b) } });
    if (bucket) {
      const g = await span.span('r2.get', () => bucket.get(key));
      if (g.tag === 'Ok' && g.value.tag === 'Some') {
        const b = await unframe(g.value.value);
        if (b.tag === 'Some') { streamStats.r2Hits++; return bytesResponse(b.value); }
      }
    }
    const scene = await sceneFor(rq, spec, pf, span);
    if (scene.tag === 'Err') return json(scene.error.status, scene.error);
    /** Keep the finished image for R2 and L1. @param {Uint8Array[]} parts @param {number} n */
    const finish = (parts, n) => {
      if (!bucket && n > L1_MAX) return;
      const bytes = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { bytes.set(p, o); o += p.length; }
      if (n <= L1_MAX) renders.set(key, bytes, n);
      if (bucket) pf.defer(frame(bytes).then((f) => bucket.put(key, f)).then((r) => { if (r.tag === 'Ok') streamStats.r2Puts++; }));
    };
    if (rq.format === 'svg') {
      const b = new TextEncoder().encode(toSvg(scene.value));
      finish([b], b.length);
      return bytesResponse(b);
    }
    streamStats.streamed++;
    // The render outlives this function: its span ends when the stream does (finished, failed or
    // cancelled), and then the trace is flushed in the background.
    /** @type {(r: string) => void} */
    let endStream = () => {};
    let rs = NOOP_SPAN;
    pf.defer(Promise.resolve(span.span('render.stream', (s) => { rs = s; return new Promise((res) => { endStream = (r) => { if (s.recording) s.set('end', r); res(r); }; }); }))
      .then(() => pf.tracer.flush()));
    const src = pngStream(scene.value, scanline, balancedZlib, { cache: outlines, span: rs }).getReader();
    /** @type {Uint8Array[]} */
    const parts = [];
    let n = 0;
    const body = new ReadableStream({
      async pull(c) {
        const step = await src.read().then((v) => ok(v), (e) => err(e instanceof Error ? e.message : String(e)));
        if (step.tag === 'Err') { rs.fail(step.error); endStream('error'); c.error(step.error); return; }
        if (step.value.done) { c.close(); if (rs.recording) rs.set('bytes', n); endStream('done'); finish(parts, n); return; }
        parts.push(step.value.value); n += step.value.value.length;
        c.enqueue(step.value.value);
      },
      cancel(reason) { streamStats.cancelled++; endStream('cancelled'); src.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return new Response(body, { headers });
  };

  /** Response headers for a render. @param {RenderReq} rq @param {string} key */
  const renderHeaders = (rq, key) => {
    const pinned = rq.source.kind !== 'url' || rq.source.sha256 !== '';
    return {
      'content-type': contentType(rq.format),
      // Content-addressed when the spec is pinned (inline, a body, an id, or a sha256); else its URL may
      // change, so keep it short.
      'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
      'cache-tag': 'glyph-render',
      etag: `"${key.slice(7, 39)}"`,
    };
  };
  const hopStats = { calls: 0, hits: 0, misses: 0, errors: 0, corrupt: 0, fallbacks: 0, streamed: 0 };

  /**
   * The public handler: L1 (small renders) → Workers Cache (GET) → produce.
   * @param {Request} req @param {Platform} pf
   */
  const handle = (req, pf) => pf.tracer.span('request', { method: req.method, path: new URL(req.url).pathname }, async (rs) => {
    const res = await route(req, pf, rs);
    if (rs.recording) { rs.set('status', res.status); rs.set('cache', res.headers.get('x-glyph-cache') || ''); }
    if (!(res.body && res.headers.get('x-glyph-cache') === 'origin')) pf.defer(Promise.resolve(pf.tracer.flush()));
    return res;
  });
  /** @param {Request} req @param {Platform} pf @param {import('../../otel-compact/src/trace.js').Span} span */
  const route = async (req, pf, span) => {
    const u = new URL(req.url);
    if (u.pathname === '/healthz') return json(200, { ok: true, version: VERSION, fonts: fonts.stats, outlines: outlines.stats, renders: renders.stats, stream: streamStats, hop: hopStats });
    if (u.pathname === '/specs') return req.method === 'POST' ? storeSpec(req, pf, span) : json(405, { error: 'method', detail: 'POST' });
    if (u.pathname.startsWith('/specs/')) return req.method === 'GET' ? getSpec(u.pathname.slice(7), pf) : json(405, { error: 'method', detail: 'GET' });
    if (u.pathname !== '/render') return json(404, { error: 'not found', detail: 'GET or POST /render, POST /specs, GET /specs/<id>' });
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'method', detail: 'GET or POST' });
    const rq = await parseRequest(req, lim);
    if (rq.tag === 'Err') return json(rq.error.status, rq.error);
    const spec = await span.span('spec', () => specBytes(rq.value.source, pf, span));
    if (spec.tag === 'Err') return json(spec.error.status, spec.error);
    const key = await renderKey(rq.value, spec.value);
    if (span.recording) { span.set('key', key.slice(7, 23)); span.set('dpr', rq.value.dpr); span.set('format', rq.value.format); }
    const headers = renderHeaders(rq.value, key);
    const small = renders.get(key);
    if (small.tag === 'Some') return new Response(/** @type {BodyInit} */ (/** @type {unknown} */ (small.value)), { headers: { ...headers, 'x-glyph-cache': 'l1' } });
    if (pf.cached && req.method === 'GET') {
      // The hop recomputes from its address (a URL or an id is in canonicalQuery); inline specs travel in it.
      hopStats.calls++;
      const addr = `https://glyph.internal/render?${canonicalQuery(rq.value)}${rq.value.source.kind === 'bytes' ? `&s=${encodeURIComponent(/** @type {string} */ (u.searchParams.get('s')))}` : ''}`;
      const hop = await span.span('workers-cache', () => /** @type {NonNullable<Platform['cached']>} */ (pf.cached).fetch(new Request(addr), { cf: { cacheKey: key } }).then((r) => ok(r), (e) => err(e instanceof Error ? e.message : String(e))));
      if (hop.tag === 'Ok' && hop.value.ok && hop.value.body) {
        const res = hop.value, hit = res.headers.get('cf-cache-status') === 'HIT';
        if (hit) hopStats.hits++; else hopStats.misses++;
        const sha = res.headers.get('x-content-sha256') || '', len = Number(res.headers.get('content-length') || -1);
        if (sha && len >= 0 && len <= L1_MAX) {
          // Small and verifiable: check the bytes against the producer's digest, keep in L1.
          const b = new Uint8Array(await res.arrayBuffer());
          if ((await digest(b)) === sha) { renders.set(key, b, b.length); return new Response(/** @type {BodyInit} */ (/** @type {unknown} */ (b)), { headers: { ...headers, 'x-glyph-cache': hit ? 'hit' : 'miss' } }); }
          hopStats.corrupt++;
        } else {
          // Large (or streamed fresh, without a digest yet): pass the stream through, unbuffered.
          hopStats.streamed++;
          return new Response(res.body, { headers: { ...headers, 'x-glyph-cache': hit ? 'hit' : 'miss' } });
        }
      } else if (hop.tag === 'Ok') { hopStats.errors++; if (hop.value.body) hop.value.body.cancel().catch(() => {}); } else hopStats.errors++;
      hopStats.fallbacks++;
    }
    return produce(rq.value, spec.value, key, pf, { ...headers, 'x-glyph-cache': 'origin' }, span);
  };

  /**
   * POST /specs: validate (parseSpec, as /render does), then store the exact bytes under their
   * SHA-256; an existing object is not rewritten (immutable, so identical uploads dedupe).
   * @param {Request} req @param {Platform} pf @param {import('../../otel-compact/src/trace.js').Span} span
   */
  const storeSpec = async (req, pf, span) => {
    if (!pf.specs) return json(NO_STORE.status, NO_STORE);
    const len = Number(req.headers.get('content-length') || 0);
    if (len > lim.storeBytes) return json(413, problem(413, 'request', { at: 'body', expected: `at most ${lim.storeBytes} bytes`, found: len }));
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > lim.storeBytes) return json(413, problem(413, 'request', { at: 'body', expected: `at most ${lim.storeBytes} bytes`, found: body.length }));
    const parsed = parseJson(body, span);
    if (parsed.tag === 'Err') return json(parsed.error.status, parsed.error);
    const valid = span.span('spec.validate', () => parseSpec(parsed.value));
    if (valid.tag === 'Err') return json(400, problem(400, 'spec', valid.error));
    const id = await digest(body);
    const store = specStore(pf.specs);
    const had = await store.head(id);
    if (had.tag === 'Err') return json(502, problem(502, 'store', had.error));
    if (!had.value) {
      const put = await span.span('specs.put', () => store.put(id, body));
      if (put.tag === 'Err') return json(502, problem(502, 'store', put.error));
    }
    if (span.recording) { span.set('id', id.slice(0, 16)); span.set('bytes', body.length); span.set('stored', !had.value); }
    const at = `${new URL(req.url).origin}/render?id=${id}`;
    return json(had.value ? 200 : 201, { id, bytes: body.length, render: at, svg: `${at}&format=svg` });
  };

  /** GET /specs/<id>: the stored bytes, verified, immutable. @param {string} id @param {Platform} pf */
  const getSpec = async (id, pf) => {
    if (!ID.test(id)) return json(404, problem(404, 'spec', { at: '/specs/<id>', expected: '64 lowercase hex digits', found: id.slice(0, 80) }));
    const b = await storedSpec(id, pf);
    if (b.tag === 'Err') return json(b.error.status, b.error);
    return new Response(/** @type {BodyInit} */ (/** @type {unknown} */ (b.value)), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable', etag: `"${id}"` } });
  };

  /**
   * The cache-enabled entrypoint's handler: recompute a job from its address. What it answers
   * is what Workers Cache stores.
   * @param {Request} req @param {Platform} pf
   */
  const handleCached = async (req, pf) => {
    const u = new URL(req.url);
    const q = u.searchParams;
    const noHop = { ...pf, cached: null };
    if (u.pathname === '/spec') {
      const s = { url: q.get('url') || '', sha256: q.get('sha256') || '' };
      return serveCached(origin, async () => ({ key: 'spec', make: () => fetchSpec(s, noHop) }), { contentType: 'application/json', maxAge: s.sha256 ? 31536000 : 60 })(req);
    }
    if (u.pathname === '/font') {
      const url = q.get('url') || '';
      return serveCached(origin, async () => ({ key: 'font', make: async () => { const r = await fetchBytes(url, { fetch: pf.fetch, policy: publicHttps, maxBytes: lim.fontBytes, timeoutMs: lim.fetchMs }); return r.tag === 'Ok' ? ok(r.value.bytes) : err(describe(r.error)); } }), { contentType: 'application/octet-stream' })(req);
    }
    if (u.pathname === '/render') {
      const rq = await parseRequest(new Request(`https://glyph.internal/render?${q}`), lim);
      if (rq.tag === 'Err') return json(rq.error.status, rq.error);
      const spec = await specBytes(rq.value.source, noHop);
      if (spec.tag === 'Err') return json(spec.error.status, spec.error);
      const key = await renderKey(rq.value, spec.value);
      return pf.tracer.span('cached.render', (cs) => produce(rq.value, spec.value, key, noHop, renderHeaders(rq.value, key), cs));
    }
    return json(404, { error: 'not found', detail: u.pathname });
  };

  return { handle, handleCached, stats: { fonts: fonts.stats, outlines: outlines.stats, renders: renders.stats, stream: streamStats, hop: hopStats }, limits: lim };
}

const NO_STORE = problem(501, 'store', 'no SPECS bucket bound');

/** Spec bytes → JSON value, or the 400 spec problem. @param {Uint8Array} spec @param {import('../../otel-compact/src/trace.js').Span} span */
function parseJson(spec, span) {
  try { return ok(/** @type {unknown} */ (span.span('spec.parse', { bytes: spec.length }, () => JSON.parse(new TextDecoder().decode(spec))))); } catch (e) { return err(problem(400, 'spec', { at: '', expected: 'JSON', found: e instanceof Error ? e.message : String(e) })); } // platform edge: JSON.parse throws
}

/**
 * The SPECS bucket as values, keyed by id (no prefix: the bucket holds only specs).
 * Platform edge: binding calls reject on network or service errors; they become values here.
 * @param {any} bucket
 */
const specStore = (bucket) => {
  const r2 = r2Store(bucket, { prefix: '', contentType: 'application/json' });
  return {
    get: r2.get,
    put: r2.put,
    /** @param {string} id @returns {Promise<import('../../otel-compact/src/adt.js').Result<boolean, string>>} */
    async head(id) {
      try { return ok(Boolean(await bucket.head(id))); } catch (e) { return err(`r2 head: ${e instanceof Error ? e.message : String(e)}`); }
    },
  };
};

/** @param {number} status @param {unknown} body @param {Record<string, string>} [extra] */
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
