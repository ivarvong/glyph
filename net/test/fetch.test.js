import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fetchBytes, fetchFont, fontJob, publicHttps, allowHosts, FetchError } from '../src/fetch.js';
import { memo, Policy } from '../../cache/src/policy.js';
import { layered, origin, memory, store, mapStore } from '../../cache/src/layers.js';

const INTER = new Uint8Array(readFileSync(new URL('../../third_party/fonts/inter-latin-400.woff2', import.meta.url)));
const policyOf = (u) => publicHttps(new URL(u));

test('publicHttps refuses the SSRF-shaped URLs and allows a public https name', () => {
  assert.equal(policyOf('https://fonts.example.com/a.woff2'), '');
  for (const [u, why] of [
    ['http://fonts.example.com/a.woff2', /https only/],
    ['https://user:pw@fonts.example.com/a', /credentials/],
    ['https://fonts.example.com:8443/a', /port/],
    ['https://127.0.0.1/a', /IP literal/],
    ['https://[::1]/a', /IP literal/],
    ['https://2130706433/a', /IP literal/],     // 127.0.0.1 as one decimal number
    ['https://localhost/a', /local host/],
    ['https://metadata.internal/a', /local host/],
    ['https://printer.local/a', /local host/],
    ['file:///etc/passwd', /https only/],
  ]) assert.match(policyOf(u), why, u);
  const only = allowHosts(['fonts.gstatic.com', '*.example.com']);
  assert.equal(only(new URL('https://fonts.gstatic.com/x')), '');
  assert.equal(only(new URL('https://cdn.example.com/x')), '');
  assert.match(only(new URL('https://evil.com/x')), /not in allowlist/);
  assert.match(only(new URL('http://fonts.gstatic.com/x')), /https only/, 'the base policy still applies');
});

/** A fake fetch from a route table: url → Response factory. Records calls. */
const fake = (routes) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new TypeError('fetch failed');
    return r(init);
  };
  return Object.assign(f, { calls });
};

test('errors are values: bad URL, refused URL, network failure, HTTP status, redirect checks', async () => {
  const f = fake({
    'https://a.example.com/404': () => new Response('no', { status: 404 }),
    'https://a.example.com/hop': () => new Response(null, { status: 302, headers: { location: 'http://a.example.com/plain' } }),
    'https://a.example.com/loop': () => new Response(null, { status: 301, headers: { location: '/loop' } }),
    'https://a.example.com/rel': () => new Response(null, { status: 307, headers: { location: '/font' } }),
    'https://a.example.com/font': () => new Response(INTER),
  });
  const tag = async (u) => { const r = await fetchBytes(u, { fetch: f }); return r.tag === 'Ok' ? 'Ok' : r.error.tag; };
  assert.equal(await tag('not a url'), 'BadUrl');
  assert.equal(await tag('https://127.0.0.1/x'), 'Disallowed');
  assert.equal(await tag('https://a.example.com/missing'), 'Network');
  assert.equal(await tag('https://a.example.com/404'), 'Status');
  assert.equal(await tag('https://a.example.com/hop'), 'Disallowed', 'a redirect to http is checked again and refused');
  assert.equal(await tag('https://a.example.com/loop'), 'TooManyRedirects');
  const ok = await fetchBytes('https://a.example.com/rel', { fetch: f });
  assert.equal(ok.tag, 'Ok');
  assert.equal(ok.value.url, 'https://a.example.com/font', 'relative Location resolved');
  assert.equal(ok.value.bytes.length, INTER.length);
  assert.ok(!f.calls.includes('http://a.example.com/plain'), 'the refused hop was never fetched');
});

test('size cap: a declared Content-Length over the cap is refused unread; a lying or absent one is cut off while reading', async () => {
  let pulled = 0;
  const endless = () => new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 << 10)); } });
  const f = fake({
    'https://a.example.com/declared': () => new Response(endless(), { headers: { 'content-length': String(1 << 30) } }),
    'https://a.example.com/lying': () => new Response(endless(), { headers: { 'content-length': '10' } }),
    'https://a.example.com/none': () => new Response(endless()),
  });
  const max = 1 << 20;
  const d = await fetchBytes('https://a.example.com/declared', { fetch: f, maxBytes: max });
  assert.equal(d.error.tag, 'TooLarge'); assert.equal(d.error.seen, 1 << 30);
  assert.ok(pulled <= 2, `declared: read ${pulled} chunks before refusing`);
  for (const u of ['https://a.example.com/lying', 'https://a.example.com/none']) {
    pulled = 0;
    const r = await fetchBytes(u, { fetch: f, maxBytes: max });
    assert.equal(r.error.tag, 'TooLarge', u);
    assert.ok(pulled <= max / (64 << 10) + 3, `${u}: stopped after ${pulled} chunks`);
  }
});

test('fetchFont: parse once per content (two URLs, one file), errors split into Fetch | Load', async () => {
  const f = fake({
    'https://a.example.com/inter.woff2': () => new Response(INTER),
    'https://mirror.example.com/same.woff2': () => new Response(INTER),
    'https://a.example.com/junk.woff2': () => new Response(new Uint8Array(100).fill(7)),
  });
  const fonts = memo(Policy.Lru, { maxBytes: 16 << 20, sizeOf: () => 1 });
  const a = await fetchFont('https://a.example.com/inter.woff2', { fetch: f, fonts });
  const b = await fetchFont('https://mirror.example.com/same.woff2', { fetch: f, fonts });
  assert.equal(a.tag, 'Ok'); assert.equal(b.tag, 'Ok');
  assert.equal(a.value.key, b.value.key, 'content key, not URL');
  assert.equal(a.value.font, b.value.font, 'parsed once');
  assert.ok(a.value.font.numGlyphs > 100);
  const junk = await fetchFont('https://a.example.com/junk.woff2', { fetch: f, fonts });
  assert.equal(junk.error.tag, 'Load');
  const refused = await fetchFont('http://a.example.com/inter.woff2', { fetch: f, fonts });
  assert.equal(refused.error.tag, 'Fetch'); assert.equal(refused.error.error.tag, 'Disallowed');
});

test('fetchFont via a cache stack: bytes are fetched once, failures are not cached', async () => {
  const f = fake({
    'https://a.example.com/inter.woff2': () => new Response(INTER),
    'https://a.example.com/500': () => new Response('x', { status: 500 }),
  });
  const kv = mapStore();
  const via = layered(memory(memo(Policy.Sieve, { maxBytes: 8 << 20, sizeOf: (b) => b.length })), store(kv))(origin);
  for (let i = 0; i < 3; i++) assert.equal((await fetchFont('https://a.example.com/inter.woff2', { fetch: f, via })).tag, 'Ok');
  assert.equal(f.calls.filter((u) => u.endsWith('inter.woff2')).length, 1);
  assert.equal(kv.map.size, 1);
  for (let i = 0; i < 2; i++) {
    const r = await fetchFont('https://a.example.com/500', { fetch: f, via });
    assert.equal(r.error.tag, 'Fetch'); assert.match(r.error.error, /answered 500/);
  }
  assert.equal(f.calls.filter((u) => u.endsWith('/500')).length, 2, 'an Err is recomputed, not cached');
  assert.match(fontJob('https://a.example.com/x').key, /^font-url:[0-9a-f]{64}$/);
});

// Integration: real sockets, real undici body streams.
const serve = (handler) => new Promise((res) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); });
const anyUrl = () => '';

test('real HTTP: the deadline covers a server that stalls mid-body, and the cap stops a firehose', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/stall') { res.writeHead(200); res.write(new Uint8Array(1000)); return; } // never ends
    if (req.url === '/firehose') { res.writeHead(200); const tick = () => { if (res.write(new Uint8Array(256 << 10))) setImmediate(tick); else res.once('drain', tick); }; tick(); req.on('close', () => res.destroy()); return; }
    if (req.url === '/font') { res.writeHead(200, { 'content-length': INTER.length }); res.end(INTER); return; }
    res.writeHead(404); res.end();
  });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    let t = performance.now();
    const stall = await fetchBytes(`${base}/stall`, { policy: anyUrl, timeoutMs: 300 });
    assert.equal(stall.error.tag, 'Timeout');
    assert.ok(performance.now() - t < 1500, `stall ended after ${(performance.now() - t).toFixed(0)} ms`);
    t = performance.now();
    const hose = await fetchBytes(`${base}/firehose`, { policy: anyUrl, maxBytes: 4 << 20 });
    assert.equal(hose.error.tag, 'TooLarge');
    assert.ok(performance.now() - t < 3000);
    const font = await fetchFont(`${base}/font`, { policy: anyUrl });
    assert.equal(font.tag, 'Ok');
    // The default policy refuses this very server: http, IP literal, explicit port.
    assert.equal((await fetchBytes(`${base}/font`)).error.tag, 'Disallowed');
  } finally { s.closeAllConnections(); s.close(); }
});

test('fetchFont via a cache stack: bytes that do not load are not cached, so the URL recovers when the origin does', async () => {
  let broken = true;
  const f = fake({ 'https://a.example.com/flaky.woff2': () => new Response(broken ? new Uint8Array(512).fill(9) : INTER) });
  const kv = mapStore();
  const via = layered(store(kv))(origin);
  const bad = await fetchFont('https://a.example.com/flaky.woff2', { fetch: f, via });
  assert.equal(bad.error.tag, 'Load', 'typed as a font error, not a fetch error');
  assert.equal(kv.map.size, 0, 'nothing cached');
  broken = false;
  const good = await fetchFont('https://a.example.com/flaky.woff2', { fetch: f, via });
  assert.equal(good.tag, 'Ok');
  assert.equal(kv.map.size, 1);
});
