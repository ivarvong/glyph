// The generic renderer (worker/src/app.js) in Node, with a fake platform: fonts from third_party/fonts/
// under their pinned upstream URLs (examples/specs/fonts.js), specs from this repo under
// https://specs.example.com/. The simulator (sim/, workerd) runs the same app for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createRenderer } from '../src/app.js';
import { FIXTURE_FONTS } from '../../examples/specs/fonts.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const isFont = (url) => url in FIXTURE_FONTS;
const calls = [];
const fakeFetch = async (url) => {
  calls.push(url);
  if (isFont(url)) return new Response(readFileSync(`${ROOT}${FIXTURE_FONTS[url]}`));
  const s = /^https:\/\/specs\.example\.com\/(.*)$/.exec(url);
  if (s) { const p = `${ROOT}examples/specs/${s[1]}`; return existsSync(p) ? new Response(readFileSync(p)) : new Response('no', { status: 404 }); }
  return new Response('not found', { status: 404 });
};
import { NOOP_TRACER } from '../../otel-compact/src/trace.js';
const platform = { fetch: fakeFetch, cached: null, bucket: null, specs: null, defer: () => {}, tracer: NOOP_TRACER };
const get = (r, q, init) => r.handle(new Request(`https://glyph.test/render?${q}`, init), platform);
const body = async (res) => new Uint8Array(await res.arrayBuffer());
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

test('renders a spec by URL; a repeat is an L1 hit with identical bytes', async () => {
  const r = createRenderer();
  const a = await get(r, 'spec=https://specs.example.com/type-card.json&dpr=1');
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(a.headers.get('content-type'), 'image/png');
  assert.equal(a.headers.get('cache-control'), 'public, max-age=60'); // unpinned URL
  const ba = await body(a);
  assert.ok(isPng(ba));
  const fontFetches = calls.filter((u) => isFont(u)).length;
  const b = await get(r, 'spec=https://specs.example.com/type-card.json&dpr=1');
  assert.deepEqual(await body(b), ba);
  assert.ok(r.stats.renders.hits >= 1, 'small render served from L1');
  assert.equal(calls.filter((u) => isFont(u)).length, fontFetches, 'no font refetch');
  // Another dpr is another render, but the parsed fonts are reused (content-keyed LRU).
  const c = await get(r, 'spec=https://specs.example.com/type-card.json&dpr=0.5');
  assert.equal(c.status, 200);
  assert.ok(r.stats.fonts.hits > 0);
});

test('params fill declared text; undeclared params are refused', async () => {
  const r = createRenderer();
  const a = await body(await get(r, 'spec=https://specs.example.com/type-card.json&dpr=0.5'));
  const b = await get(r, 'spec=https://specs.example.com/type-card.json&dpr=0.5&p.title=HELLO');
  assert.equal(b.status, 200);
  assert.notDeepEqual(await body(b), a);
  const c = await get(r, 'spec=https://specs.example.com/type-card.json&p.nope=x');
  assert.equal(c.status, 400);
  assert.equal((await c.json()).detail[0].at, '?p.nope');
});

test('inline specs (base64url, and z + deflate-raw) and POST bodies render the same picture', async () => {
  const r = createRenderer();
  const json = readFileSync(`${ROOT}examples/specs/type-card.json`);
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const plain = await get(r, `s=${b64(json)}&dpr=0.5`);
  assert.equal(plain.status, 200, await plain.clone().text());
  assert.equal(plain.headers.get('cache-control'), 'public, max-age=31536000, immutable'); // content-addressed
  const z = await get(r, `s=z${b64(deflateRawSync(json))}&dpr=0.5`);
  const post = await get(r, 'dpr=0.5', { method: 'POST', body: json });
  const p = await body(plain);
  assert.deepEqual(await body(z), p);
  assert.deepEqual(await body(post), p);
});

test('errors are values with statuses and JSON pointers', async () => {
  const r = createRenderer();
  const bad = async (q, init, status) => { const res = await get(r, q, init); assert.equal(res.status, status, q); return res.json(); };
  assert.equal((await bad('spec=https://specs.example.com/x.json&dpr=9', undefined, 400)).detail.at, '?dpr');
  assert.equal((await bad('dpr=1', undefined, 400)).detail.at, '?spec');
  assert.equal((await bad('s=!!!', undefined, 400)).detail.at, '?s');
  await bad('spec=https://specs.example.com/missing.json', undefined, 502);
  await bad('spec=http://specs.example.com/type-card.json', undefined, 400); // policy: https only, the client's error
  const v = await bad('dpr=1', { method: 'POST', body: JSON.stringify({ glyph: 1, size: [10, 10], items: [{ circle: [1, 2] }, { path: 'M0 0 L' }, { text: 'x', font: 'nope' }] }) }, 400);
  assert.deepEqual(v.detail.map((e) => e.at), ['/items/0/circle', '/items/1/path', '/items/2/font', '/items/2/size']);
  assert.equal((await bad('dpr=1', { method: 'POST', body: '{not json' }, 400)).error, 'spec');
  assert.equal((await r.handle(new Request('https://glyph.test/nope'), platform)).status, 404);
});

test('a pinned font whose bytes differ is refused, not drawn', async () => {
  const r = createRenderer();
  const spec = JSON.parse(readFileSync(`${ROOT}examples/specs/type-card.json`, 'utf8'));
  spec.fonts.mono.sha256 = '0'.repeat(64);
  const res = await get(r, 'dpr=0.5', { method: 'POST', body: JSON.stringify(spec) });
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.equal(j.error, 'font');
  assert.equal(j.detail.error.tag, 'Integrity');
});

test('a traced request records the whole tree, including the streamed render', async () => {
  const { tracer, Config, memorySink } = await import('../../otel-compact/src/trace.js');
  const sink = memorySink();
  const pending = [];
  const pf = { ...platform, defer: (p) => pending.push(p), tracer: tracer(Config.Record(sink, {})) };
  const r = createRenderer();
  const res = await r.handle(new Request('https://glyph.test/render?spec=https://specs.example.com/type-card.json&dpr=0.5'), pf);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  await Promise.all(pending);
  await pf.tracer.flush();
  const { parse } = await import('../../otel-compact/src/read.js');
  const names = new Set(parse(sink.lines.join('\n')).spans.map((x) => x.name));
  for (const n of ['request', 'spec', 'spec.parse', 'scene.build', 'font', 'render.stream', 'raster.plan', 'band', 'raster.flatten', 'png.deflate']) assert.ok(names.has(n), `span ${n} in ${[...names]}`);
});
