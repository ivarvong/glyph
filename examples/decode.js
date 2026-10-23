// OTEL_COMPACT=jsonl:out/trace.jsonl node examples/decode.js [iterations]
// With OTEL_COMPACT unset the identical code path runs untraced.
import { readFileSync } from 'node:fs';
import { tracerFromEnv } from '../otel-compact/src/node.js';
import { decodeWoff2 } from '../woff2/src/woff2.js';
import { autoBrotli } from '../woff2/src/brotli.js';

const FIXTURES = ['inter-latin-400.woff2', 'source-serif-4-regular.otf.woff2'];
const iterations = Number(process.argv[2] ?? 20);

const t = (() => { const r = tracerFromEnv(process.env, { service: 'glyph', resource: { node: process.version } }); if (r.tag === 'Ok') return r.value; console.error(r.error); process.exit(2); })();
const fonts = FIXTURES.map((f) => [f, new Uint8Array(readFileSync(new URL(`../third_party/fonts/${f}`, import.meta.url)))]);

for (let i = 0; i < iterations; i++) {
  for (const [file, bytes] of fonts) {
    const r = await t.span('decode', { file, iter: i }, (s) => decodeWoff2(bytes, { decompress: autoBrotli, span: s }));
    if (r.tag !== 'Ok') throw new Error(`${file}: ${JSON.stringify(r.error)}`);
  }
}
await t.flush();
