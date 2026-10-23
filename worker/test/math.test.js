// The Worker renders "math" items: the font is Latin Modern Math, fetched by URL through the fake
// platform (from third_party/fonts/, npm run fetch, pinned by SHA-256), so these run without the google/fonts checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRenderer } from '../src/app.js';
import { NOOP_TRACER } from '../../otel-compact/src/trace.js';
import { decodePng, toRgba } from '../../verify/pngdecode.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const LMM_URL = 'https://mirrors.ctan.org/fonts/lm-math/opentype/latinmodern-math.otf';
const fetches = [];
const fetch = async (url) => {
  fetches.push(url);
  if (url === LMM_URL) return new Response(readFileSync(`${ROOT}third_party/fonts/latinmodern-math.otf`));
  if (url === 'https://specs.example.com/math-card.json') return new Response(readFileSync(`${ROOT}examples/specs/math-card.json`));
  return new Response('not found', { status: 404 });
};
const platform = { fetch, cached: null, bucket: null, specs: null, defer: () => {}, tracer: NOOP_TRACER };
const post = (r, q, spec) => r.handle(new Request(`https://glyph.test/render?${q}`, { method: 'POST', body: JSON.stringify(spec) }), platform);
const spec = (items) => ({ glyph: 1, size: [300, 100], fonts: { lm: { url: LMM_URL, sha256: '6075562b771f8b82f0c179e363389684f2dd09de30038269e2628e504bd7be0f' } }, items });

test('the example math card renders by URL, with a param; PNG and SVG', async () => {
  const r = createRenderer();
  const a = await r.handle(new Request('https://glyph.test/render?spec=https://specs.example.com/math-card.json&dpr=1'), platform);
  assert.equal(a.status, 200, await a.clone().text());
  const png = decodePng(new Uint8Array(await a.arrayBuffer()));
  assert.deepEqual([png.width, png.height], [1200, 630]);
  const px = toRgba(png);
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 100) ink++;
  assert.ok(ink > 5000, `${ink} dark pixels`);
  const b = await r.handle(new Request('https://glyph.test/render?spec=https://specs.example.com/math-card.json&dpr=1&p.formula=%5Csum_%7Bk%3D1%7D%5En%20k'), platform);
  assert.equal(b.status, 200);
  const svg = await r.handle(new Request('https://glyph.test/render?spec=https://specs.example.com/math-card.json&format=svg'), platform);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(await svg.text(), /^<svg[^>]*width="1200"/);
});

test('bad LaTeX is a 400 with a JSON pointer and the offset; so are a missing glyph and bad LaTeX from a param', async () => {
  const r = createRenderer();
  const a = await post(r, 'dpr=1', spec([{ math: '\\frac{a}{b', font: 'lm', size: 30, at: [10, 60] }]));
  assert.equal(a.status, 400);
  const ja = await a.json();
  assert.deepEqual(ja.detail, [{ at: '/items/0/math', expected: "TeX math (expected '}', found end of input at 10)", found: '"\\\\frac{a}{b"' }]);
  const b = await post(r, 'dpr=1', spec([{ math: '\\mathcal{q}', font: 'lm', size: 30 }]));
  assert.equal(b.status, 400);
  assert.equal((await b.json()).detail[0].found, 'U+1D4C6 at 9');
  const c = await post(r, 'dpr=1&p.f=%5Cfoo', { ...spec([{ math: '${f}', font: 'lm', size: 30 }]), params: { f: 'x' } });
  assert.equal(c.status, 400);
  assert.equal((await c.json()).detail[0].expected, 'TeX math (unknown command \\foo at 0)');
});

test('the same math spec renders the same bytes twice; the font is fetched once', async () => {
  const r = createRenderer();
  const s = spec([{ math: '\\sum_{k=0}^n \\binom{n}{k} = 2^n', font: 'lm', size: 28, at: [150, 60], display: true, align: 'center' }]);
  const n0 = fetches.filter((u) => u === LMM_URL).length;
  const x = new Uint8Array(await (await post(r, 'dpr=2', s)).arrayBuffer());
  const y = new Uint8Array(await (await post(r, 'dpr=2', s)).arrayBuffer());
  assert.deepEqual(x, y);
  assert.equal(decodePng(x).width, 600);
  assert.equal(fetches.filter((u) => u === LMM_URL).length - n0, 1);
});
