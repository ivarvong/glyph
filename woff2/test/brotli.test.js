import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { brotliCompressSync, brotliDecompressSync, constants as Z } from 'node:zlib';
import { brotliDecode, BrotliError } from '../src/brotli-js.js';
import { readContainer } from '../src/woff2.js';
import { DICTIONARY_SHA256, DICTIONARY_BASE64 } from '../src/brotli-data.js';
import { createHash } from 'node:crypto';

const fixture = (p) => new Uint8Array(readFileSync(new URL(`../../third_party/fonts/${p}`, import.meta.url)));

test('embedded dictionary matches its recorded sha256 (RFC 7932 Appendix A)', () => {
  const d = Buffer.from(DICTIONARY_BASE64, 'base64');
  assert.equal(d.length, 122784);
  assert.equal(createHash('sha256').update(d).digest('hex'), DICTIONARY_SHA256);
});

test('both WOFF2 fixtures: pure-JS output is byte-identical to node:zlib', () => {
  for (const f of ['inter-latin-400.woff2', 'source-serif-4-regular.otf.woff2']) {
    const c = readContainer(fixture(f)).value;
    const r = brotliDecode(c.compressed, { sizeHint: c.expectedStream });
    assert.equal(r.tag, 'Ok', JSON.stringify(r.error));
    assert.deepEqual(Buffer.from(r.value), brotliDecompressSync(c.compressed));
  }
});

// Seeded inputs that push the encoder into different code paths: dictionary
// words with transforms (text), long matches (repeats), incompressible bytes,
// and font-like binary. Every quality 0-11 × window 10/16/22/24 × mode.
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const corpus = (() => {
  const r = rng(42);
  const words = 'the of and to in is that for with as The This From YOU are be at by HTML <div class="x"> http://www. .com/ ing ed ly'.split(' ');
  const text = Array.from({ length: 6000 }, () => words[Math.floor(r() * words.length)] + (r() < 0.1 ? '.\n' : ' ')).join('');
  return {
    text: new TextEncoder().encode(text),
    utf8: new TextEncoder().encode('Ångström café naïve résumé — “quotes” 日本語テキスト '.repeat(300)),
    random: Uint8Array.from({ length: 20000 }, () => Math.floor(r() * 256)),
    repeats: Uint8Array.from({ length: 70000 }, (_, i) => (i % 3 === 0 ? (i >> 10) & 255 : 7)),
    font: fixture('inter-latin-400.woff').subarray(0, 30000),
    tiny: new Uint8Array([0]),
    empty: new Uint8Array(0),
  };
})();

test('differential: node:zlib encoder × {quality 0-11, lgwin 10/16/22/24, 3 modes} × 7 inputs', () => {
  let n = 0;
  for (const [name, data] of Object.entries(corpus)) {
    for (let q = 0; q <= 11; q++) {
      for (const lgwin of [10, 16, 22, 24]) {
        for (const mode of [Z.BROTLI_MODE_GENERIC, Z.BROTLI_MODE_TEXT, Z.BROTLI_MODE_FONT]) {
          const enc = brotliCompressSync(data, { params: { [Z.BROTLI_PARAM_QUALITY]: q, [Z.BROTLI_PARAM_LGWIN]: lgwin, [Z.BROTLI_PARAM_MODE]: mode, [Z.BROTLI_PARAM_SIZE_HINT]: data.length } });
          const r = brotliDecode(new Uint8Array(enc));
          assert.equal(r.tag, 'Ok', `${name} q${q} w${lgwin} m${mode}: ${JSON.stringify(r.error)}`);
          assert.ok(Buffer.from(r.value).equals(Buffer.from(data)), `${name} q${q} w${lgwin} m${mode}: mismatch`);
          n++;
        }
      }
    }
  }
  assert.equal(n, 7 * 12 * 4 * 3);
});

test('google/brotli tests/testdata vectors (when the checkout is present)', (t) => {
  const dir = process.env.BROTLI_TESTDATA ?? '/tmp/f/brotli/tests/testdata';
  if (!existsSync(dir)) return t.skip(`no ${dir}`);
  const files = readdirSync(dir).filter((f) => /\.compressed(\.\d+)?$/.test(f));
  for (const f of files) {
    const r = brotliDecode(new Uint8Array(readFileSync(`${dir}/${f}`)));
    assert.equal(r.tag, 'Ok', `${f}: ${JSON.stringify(r.error)}`);
    assert.ok(Buffer.from(r.value).equals(readFileSync(`${dir}/${f.replace(/\.compressed(\.\d+)?$/, '')}`)), f);
  }
  assert.ok(files.length >= 40);
});

test('fuzz: truncations and bit flips give Ok-with-different-bytes or a typed error, never a throw', () => {
  const enc = new Uint8Array(brotliCompressSync(corpus.text, { params: { [Z.BROTLI_PARAM_QUALITY]: 11 } }));
  const r = rng(7);
  const seen = {};
  for (let i = 0; i < 3000; i++) {
    let b = enc.slice();
    if (i % 2) b = b.subarray(0, Math.floor(r() * b.length));
    else for (let k = 0; k < 1 + r() * 4; k++) b[Math.floor(r() * b.length)] ^= 1 << Math.floor(r() * 8);
    const out = brotliDecode(b, { maxOutput: 1 << 22 });
    assert.ok(out.tag === 'Ok' || BrotliError.is(out.error));
    const k = out.tag === 'Ok' ? 'Ok' : `${out.error.tag}${out.error.what ? `:${out.error.what}` : ''}`;
    seen[k] = (seen[k] ?? 0) + 1;
  }
  assert.ok(seen['Truncated'] > 100, JSON.stringify(seen));
  assert.ok(Object.keys(seen).length >= 6, JSON.stringify(seen));
});
