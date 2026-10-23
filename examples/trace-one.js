// One render, traced: Inter WOFF2 bytes -> "Cloudflare" @96px -> SVG + PNG.
//   OTEL_COMPACT=jsonl:out/one.jsonl node examples/trace-one.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tracerFromEnv, observeGc } from '../otel-compact/src/node.js';

const t = (() => { const r = tracerFromEnv(process.env, { service: 'glyph', resource: { example: 'trace-one', node: process.version } }); if (r.tag === 'Ok') return r.value; console.error(r.error); process.exit(2); })();
const stopGc = observeGc(t);

// Module load is part of a cold start (parse + top-level evaluation), so it gets a span too.
const { autoBrotli, loadFont, renderText } = await t.span('module.import', async () => {
  const [b, r] = await Promise.all([import('../woff2/src/brotli.js'), import('../render/src/text.js')]);
  return { autoBrotli: b.autoBrotli, loadFont: r.loadFont, renderText: r.renderText };
});

// Calibration: the tracer's own cost per child span, billed to the parent. otc gaps subtracts it.
// Repeated so the last ones run on optimised code; otc takes the minimum.
for (let k = 0; k < 10; k++) t.span('otel.calibrate', (c) => { for (let i = 0; i < 200; i++) c.span('otel.calibrate.child', () => {}); });
const bytes = new Uint8Array(readFileSync(new URL('../third_party/fonts/inter-latin-400.woff2', import.meta.url)));
mkdirSync(new URL('../out/', import.meta.url), { recursive: true });

// Iteration 0 is the cold render (lazy compile, IC warmup, first native-stream setup).
// Later iterations redo every step from bytes (new Font, no caches) on warm code.
const N = Number(process.env.ITER ?? 3);
for (let iter = 0; iter < N; iter++) await t.span('render.one', { iter, phase: iter === 0 ? 'cold' : 'warm', font: 'inter-latin-400.woff2', text: 'Cloudflare', size: 96 }, async (s) => {
  const f = await loadFont(bytes, { brotli: autoBrotli, span: s });
  if (f.tag !== 'Ok') throw new Error(JSON.stringify(f.error));
  const r = await renderText([{ fontKey: 'inter', font: f.value, text: 'Cloudflare', size: 96 }], { span: s });
  if (r.tag !== 'Ok') throw new Error(JSON.stringify(r.error));
  for (const o of r.value.outputs) s.span('io.write', { atomic: true, file: `out/one.${o.ext}`, items: o.bytes.length }, () => writeFileSync(new URL(`../out/one.${o.ext}`, import.meta.url), o.bytes));
});
await new Promise((r) => setTimeout(r, 50)); // let the GC observer deliver its last entries
stopGc();
await t.flush();
