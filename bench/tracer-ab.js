// A/B: the full render with tracing off vs on (same process shape), wall time per render.
//   node bench/tracer-ab.js
import { readFileSync } from 'node:fs';
import { tracer, Config, NOOP_TRACER } from '../otel-compact/src/trace.js';
import { autoBrotli } from '../woff2/src/brotli.js';
import { loadFont, renderText } from '../render/src/text.js';

const bytes = new Uint8Array(readFileSync(new URL('../third_party/fonts/inter-latin-400.woff2', import.meta.url)));
let lines = 0;
const arm = process.argv[2] ?? 'jsonl';
const on = tracer(Config.Record({ write: () => { lines++; } }, { service: 'ab', defer: 512, format: arm }));
const once = async (t) => t.span('render.one', async (s) => {
  const f = await loadFont(bytes, { brotli: autoBrotli, span: s });
  return renderText([{ fontKey: 'inter', font: f.value, text: 'Cloudflare', size: 96 }], { span: s });
});
for (let i = 0; i < 10; i++) { await once(NOOP_TRACER); await once(on); } // warm both paths
const time = async (t, n) => { const xs = []; for (let i = 0; i < n; i++) { const a = performance.now(); await once(t); xs.push(performance.now() - a); } return xs.sort((a, b) => a - b); };
const N = 40;
// Interleave blocks to spread GC / thermal drift across both arms.
const off = [], rec = [];
for (let b = 0; b < 4; b++) { off.push(...await time(NOOP_TRACER, N / 4)); rec.push(...await time(on, N / 4)); }
const q = (xs, p) => xs.sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
console.log(`off: p50 ${q(off, 0.5).toFixed(2)}ms  p10 ${q(off, 0.1).toFixed(2)}  p90 ${q(off, 0.9).toFixed(2)}`);
console.log(`on (${arm}, defer 512): p50 ${q(rec, 0.5).toFixed(2)}ms  p10 ${q(rec, 0.1).toFixed(2)}  p90 ${q(rec, 0.9).toFixed(2)}   spans/render ${Math.round(lines / (10 + N))}`);
console.log(`overhead p50 ${(q(rec, 0.5) - q(off, 0.5)).toFixed(2)}ms (${((q(rec, 0.5) / q(off, 0.5) - 1) * 100).toFixed(1)}%)`);
