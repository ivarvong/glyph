// `s=` as URL-encoded JSON: the same bytes, render and key as base64url, through L1 and through the
// Workers Cache hop (handleCached, standing in for the cache-enabled entrypoint). The font is Latin
// Modern Math from third_party/fonts/ (npm run fetch), pinned by SHA-256, so these run without the google/fonts checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRenderer } from '../src/app.js';
import { NOOP_TRACER } from '../../otel-compact/src/trace.js';
import { decodePng } from '../../verify/pngdecode.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const LMM_URL = 'https://mirrors.ctan.org/fonts/lm-math/opentype/latinmodern-math.otf';
const fetch = async (url) => url === LMM_URL ? new Response(readFileSync(`${ROOT}third_party/fonts/latinmodern-math.otf`)) : new Response('not found', { status: 404 });
const platform = { fetch, cached: null, bucket: null, specs: null, defer: () => {}, tracer: NOOP_TRACER };
const get = (r, q, pf = platform) => r.handle(new Request(`https://glyph.test/render?${q}`), pf);
const body = async (res) => new Uint8Array(await res.arrayBuffer());
const b64 = (s) => Buffer.from(s).toString('base64url');
const card = readFileSync(`${ROOT}examples/specs/math-card.json`, 'utf8');
// `&`, `#`, `+`, `%`, a space, non-ASCII, `\frac` and a `${param}`: everything a raw query mangles.
const tricky = JSON.stringify({
  glyph: 1, size: [320, 120], fonts: { lm: { url: LMM_URL, sha256: '6075562b771f8b82f0c179e363389684f2dd09de30038269e2628e504bd7be0f' } },
  params: { f: '\\frac{a+b}{c}' }, meta: 'A & B #1 + 50% — π ≈ 3.14',
  items: [{ math: '${f} + \\alpha', font: 'lm', size: 30, at: [160, 70], display: true, align: 'center' }],
});

test('s= as URL-encoded JSON renders the bytes, and has the key, of the same spec as base64url', async () => {
  const r = createRenderer();
  const a = await get(r, `s=${encodeURIComponent(card)}&dpr=1&p.formula=${encodeURIComponent('\\sum_{k=1}^n k')}`);
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(a.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const r2 = createRenderer();
  const b = await get(r2, `s=${b64(card)}&dpr=1&p.formula=${encodeURIComponent('\\sum_{k=1}^n k')}`);
  assert.equal(a.headers.get('etag'), b.headers.get('etag'), 'one key for the same spec bytes');
  const pa = await body(a);
  assert.deepEqual(pa, await body(b));
  assert.equal(decodePng(pa).width, 1200);
  // Leading whitespace is still JSON; URLSearchParams turns `+` into a space, which JSON allows.
  const c = await get(r2, `s=+${encodeURIComponent(card)}&dpr=1`);
  assert.equal(c.status, 200, await c.clone().text());
});

test('JSON with & # + % and non-ASCII round-trips through s=, the same as base64url', async () => {
  const r = createRenderer();
  const a = await get(r, `s=${encodeURIComponent(tricky)}&dpr=1`);
  assert.equal(a.status, 200, await a.clone().text());
  const b = await get(createRenderer(), `s=${b64(tricky)}&dpr=1`);
  assert.equal(a.headers.get('etag'), b.headers.get('etag'));
  assert.deepEqual(await body(a), await body(b));
});

test('malformed JSON in s= is the spec parse problem; oversize JSON is a 414 counted in bytes', async () => {
  const r = createRenderer({ inlineChars: 100 });
  const a = await get(r, `s=${encodeURIComponent('{not json')}`);
  assert.equal(a.status, 400);
  assert.equal((await a.json()).error, 'spec');
  const big = `{"a":"${'é'.repeat(60)}"}`; // 68 characters, 128 bytes
  const b = await get(r, `s=${encodeURIComponent(big)}`);
  assert.equal(b.status, 414);
  assert.deepEqual((await b.json()).detail, { at: '?s', expected: 'at most 100 bytes', found: 128 });
  const c = await get(r, 's=!!!');
  assert.equal(c.status, 400);
  assert.match((await c.json()).detail.expected, /^URL-encoded JSON, base64url JSON/);
});

test('the Workers Cache hop carries a JSON s= intact: same key, same bytes, no fallback', async () => {
  const r = createRenderer();
  const hops = [];
  const pf = { ...platform, cached: { fetch: (req, init) => { hops.push({ url: req.url, key: init.cf.cacheKey }); return r.handleCached(req, platform); } } };
  const a = await get(r, `s=${encodeURIComponent(tricky)}&dpr=1`, pf);
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(a.headers.get('x-glyph-cache'), 'miss');
  assert.equal(r.stats.hop.fallbacks, 0);
  assert.equal(hops.length, 1);
  assert.equal(new URL(hops[0].url).searchParams.get('s'), tricky);
  const direct = await get(createRenderer(), `s=${b64(tricky)}&dpr=1`);
  assert.equal(`"${hops[0].key.slice(7, 39)}"`, direct.headers.get('etag'));
  assert.deepEqual(await body(a), await body(direct));
});
