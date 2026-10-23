// Stored specs: POST /specs validates and stores the exact bytes under their SHA-256 in a SPECS
// bucket (here a fake in-memory R2: get/head/put), and GET /render?id= renders them like any other
// source, through L1 and through the Workers Cache hop (handleCached, standing in for the
// cache-enabled entrypoint). The font is Latin Modern Math from third_party/fonts/ (npm run fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRenderer } from '../src/app.js';
import { NOOP_TRACER } from '../../otel-compact/src/trace.js';
import { decodePng } from '../../verify/pngdecode.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const LMM_URL = 'https://mirrors.ctan.org/fonts/lm-math/opentype/latinmodern-math.otf';
const fetch = async (url) => url === LMM_URL ? new Response(readFileSync(`${ROOT}third_party/fonts/latinmodern-math.otf`)) : new Response('not found', { status: 404 });
const fakeR2 = () => {
  const map = new Map(), ops = { get: 0, head: 0, put: 0 };
  const obj = (b) => ({ arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  return {
    map, ops,
    async get(k) { ops.get++; return map.has(k) ? obj(map.get(k)) : null; },
    async head(k) { ops.head++; return map.has(k) ? { key: k, size: map.get(k).length } : null; },
    async put(k, v) { ops.put++; map.set(k, new Uint8Array(v)); return { key: k }; },
  };
};
const platformWith = (specs) => ({ fetch, cached: null, bucket: null, specs, defer: () => {}, tracer: NOOP_TRACER });
const at = (r, path, pf, init) => r.handle(new Request(`https://glyph.test${path}`, init), pf);
const body = async (res) => new Uint8Array(await res.arrayBuffer());
const sha = (b) => createHash('sha256').update(b).digest('hex');
const card = readFileSync(`${ROOT}examples/specs/math-card.json`);

test('POST /specs stores the exact bytes under their sha256; a repeat is a 200 with no second put', async () => {
  const r = createRenderer(), r2 = fakeR2(), pf = platformWith(r2);
  const a = await at(r, '/specs', pf, { method: 'POST', body: card });
  assert.equal(a.status, 201, await a.clone().text());
  const id = sha(card);
  assert.deepEqual(await a.json(), { id, bytes: card.length, render: `https://glyph.test/render?id=${id}`, svg: `https://glyph.test/render?id=${id}&format=svg` });
  assert.deepEqual(r2.map.get(id), new Uint8Array(card));
  const b = await at(r, '/specs', pf, { method: 'POST', body: card });
  assert.equal(b.status, 200);
  assert.equal((await b.json()).id, id);
  assert.equal(r2.ops.put, 1);
  const s = await at(r, `/specs/${id}`, pf);
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('content-type'), 'application/json');
  assert.equal(s.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(await body(s), new Uint8Array(card));
});

test('?id= renders the stored spec with the key and bytes of the same spec by POST and by s=', async () => {
  const r2 = fakeR2(), pf = platformWith(r2);
  const { id } = await (await at(createRenderer(), '/specs', pf, { method: 'POST', body: card })).json();
  const p = `&dpr=1&p.formula=${encodeURIComponent('\\sum_{k=1}^n k')}`;
  const a = await at(createRenderer(), `/render?id=${id}${p}`, pf);
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(a.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const post = await at(createRenderer(), `/render?${p.slice(1)}`, pf, { method: 'POST', body: card });
  const inline = await at(createRenderer(), `/render?s=${encodeURIComponent(card.toString('utf8'))}${p}`, pf);
  assert.equal(a.headers.get('etag'), post.headers.get('etag'), 'one key for the same spec bytes');
  assert.equal(a.headers.get('etag'), inline.headers.get('etag'));
  const pa = await body(a);
  assert.deepEqual(pa, await body(post));
  assert.deepEqual(pa, await body(inline));
  assert.equal(decodePng(pa).width, 1200);
  const svg = await at(createRenderer(), `/render?id=${id}&format=svg`, pf);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
});

test('the Workers Cache hop carries the id: same key, same bytes, no fallback', async () => {
  const r2 = fakeR2(), pf0 = platformWith(r2);
  const { id } = await (await at(createRenderer(), '/specs', pf0, { method: 'POST', body: card })).json();
  const r = createRenderer();
  const hops = [];
  const pf = { ...pf0, cached: { fetch: (req, init) => { hops.push({ url: req.url, key: init.cf.cacheKey }); return r.handleCached(req, pf0); } } };
  const a = await at(r, `/render?id=${id}&dpr=1`, pf);
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(a.headers.get('x-glyph-cache'), 'miss');
  assert.equal(r.stats.hop.fallbacks, 0);
  assert.equal(hops.length, 1);
  assert.equal(new URL(hops[0].url).searchParams.get('id'), id);
  const direct = await at(createRenderer(), '/render?dpr=1', pf0, { method: 'POST', body: card });
  assert.equal(`"${hops[0].key.slice(7, 39)}"`, direct.headers.get('etag'));
  assert.deepEqual(await body(a), await body(direct));
});

test('only valid specs are stored; the problems are the ones /render gives; the size cap is storeBytes', async () => {
  const r = createRenderer({ storeBytes: 2048 }), r2 = fakeR2(), pf = platformWith(r2);
  const bad = JSON.stringify({ glyph: 1, size: [10, 10], items: [{ circle: [1, 2] }, { path: 'M0 0 L' }] });
  const a = await at(r, '/specs', pf, { method: 'POST', body: bad });
  assert.equal(a.status, 400);
  const viaRender = await at(r, '/render?dpr=1', pf, { method: 'POST', body: bad });
  assert.deepEqual(await a.json(), await viaRender.json());
  const b = await at(r, '/specs', pf, { method: 'POST', body: '{not json' });
  assert.equal(b.status, 400);
  assert.equal((await b.json()).error, 'spec');
  const c = await at(r, '/specs', pf, { method: 'POST', body: JSON.stringify({ glyph: 1, size: [10, 10], meta: 'x'.repeat(4096), items: [] }) });
  assert.equal(c.status, 413);
  assert.equal((await c.json()).detail.expected, 'at most 2048 bytes');
  assert.equal(r2.map.size, 0);
});

test('unknown, malformed and tampered ids; without a SPECS bucket the store answers 501 and the rest works', async () => {
  const r = createRenderer(), r2 = fakeR2(), pf = platformWith(r2);
  const none = '0'.repeat(64);
  const a = await at(r, `/render?id=${none}`, pf);
  assert.equal(a.status, 404);
  assert.equal((await a.json()).error, 'spec');
  assert.equal((await at(r, `/specs/${none}`, pf)).status, 404);
  assert.equal((await at(r, '/specs/nope', pf)).status, 404);
  const b = await at(r, '/render?id=ABC', pf);
  assert.equal(b.status, 400);
  assert.equal((await b.json()).detail.at, '?id');
  r2.map.set(sha(card), new TextEncoder().encode('{"glyph":1,"size":[1,1],"items":[]}'));
  const t = await at(r, `/render?id=${sha(card)}`, pf);
  assert.equal(t.status, 502);
  assert.equal((await t.json()).error, 'store');
  assert.equal((await at(r, '/specs', pf)).status, 405);
  const off = platformWith(null);
  for (const [path, init] of [['/specs', { method: 'POST', body: card }], [`/render?id=${none}`], [`/specs/${none}`]]) {
    const res = await at(r, path, off, init);
    assert.equal(res.status, 501, path);
    assert.deepEqual(await res.json(), { status: 501, error: 'store', detail: 'no SPECS bucket bound' });
  }
  assert.equal((await at(r, '/render?dpr=1', off, { method: 'POST', body: card })).status, 200);
});
