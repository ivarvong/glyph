import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { fastZlib, zlibOf, greedyFixedZlib } from '../src/png.js';
import { Lz, Entropy, huffLengths } from '../src/deflate.js';

let seed = 11;
const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
const INPUTS = [
  new Uint8Array(0), new Uint8Array(1), new Uint8Array(2).fill(7), new Uint8Array(65535), new Uint8Array(70000).fill(3),
  new Uint8Array(200000).map(() => (rnd() < 0.9 ? 0 : rnd() * 256)),
  new Uint8Array(300000).map((_, i) => ((i * 7) & 255) ^ (rnd() < 0.01 ? 9 : 0)),
  new Uint8Array(100000).map(() => rnd() * 256),
  new TextEncoder().encode('abcabcabd'.repeat(20000) + 'the quick brown fox '.repeat(3000)),
];
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

test('pluggable core as Greedy × Fixed reproduces the original fast encoder byte for byte', async () => {
  for (const src of INPUTS) assert.ok(same(await fastZlib.deflate(src), await greedyFixedZlib.deflate(src)), `n=${src.length}`);
});

test('every Lz × Entropy: inflates via node:zlib and DecompressionStream; streamed == whole at random chunking', async () => {
  const lzs = [['greedy', Lz.Greedy], ['chain', Lz.Chain(32, 16, 128, 8, 258)], ['sparse', Lz.Chain(16, 16, 64, 8, 8)], ['deep', Lz.Chain(256, 258, 258, 32, 16)]];
  for (const [ln, lz] of lzs) for (const [en, entropy, blockBytes] of [['fixed', Entropy.Fixed], ['dyn', Entropy.Dynamic], ['dyn-64k', Entropy.Dynamic, 1 << 16], ['dyn-1k', Entropy.Dynamic, 1000]]) {
    const z = zlibOf({ name: `${ln}-${en}`, lz, entropy, blockBytes });
    for (const src of INPUTS) {
      const whole = await z.deflate(src);
      assert.ok(same(inflateSync(whole), src), `${z.name} n=${src.length}: node:zlib`);
      const ds = await new Response(new Blob([whole]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
      assert.ok(same(new Uint8Array(ds), src), `${z.name} n=${src.length}: DecompressionStream`);
      const st = z.stream(), parts = [];
      for (let i = 0; i < src.length;) { const k = 1 + Math.floor(rnd() * (rnd() < 0.3 ? 3 : 40000)); parts.push(await st.push(src.subarray(i, i + k))); i += k; }
      parts.push(await st.finish());
      assert.ok(same(Buffer.concat(parts.map((p) => Buffer.from(p))), whole), `${z.name} n=${src.length}: streamed`);
    }
  }
});

test('huffLengths: complete codes within the limit, even for Fibonacci frequencies', () => {
  const fib = [1, 1]; while (fib.length < 30) fib.push(fib.at(-1) + fib.at(-2));
  for (const [freq, limit] of [[fib, 15], [fib.slice(0, 19), 7], [[5, 0, 0], 15], [[0, 0, 3, 0], 7], [Array(286).fill(1), 15]]) {
    const lens = huffLengths(Uint32Array.from(freq), limit);
    const kraft = [...lens].reduce((s, l) => s + (l ? 2 ** -l : 0), 0);
    assert.ok(Math.max(...lens) <= limit, `max ${Math.max(...lens)} > ${limit}`);
    assert.equal(kraft, 1, `Kraft sum ${kraft} for ${freq.length} symbols`);
    freq.forEach((f, i) => { if (f) assert.ok(lens[i] > 0); });
  }
});
