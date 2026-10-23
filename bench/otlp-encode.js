// Encode throughput on a real trace: forward vs reverse protobuf vs JSON paths.
import { readFileSync } from 'node:fs';
import { parse, toOtlp } from '../otel-compact/src/read.js';
import { batchFromRecords, encodeForward, encodeReverse } from '../otel-compact/src/otlp.js';

const parsed = parse(readFileSync(process.argv[2] ?? 'out/one.jsonl', 'utf8'));
const batch = batchFromRecords(parsed.spans);
const res = { service: 'glyph', attrs: [['node', process.version]], scope: 'otel-compact', version: '1' };
const lines = parsed.spans.map((s) => ({ k: 's', tr: s.traceId, id: s.id, pa: s.parent, n: s.name, ts: Math.round(s.start), du: s.dur, a: s.attrs }));

const cases = {
  'proto reverse': () => encodeReverse(batch, res).length,
  'proto forward': () => encodeForward(batch, res).length,
  'jsonl (stringify per line)': () => lines.reduce((n, l) => n + JSON.stringify(l).length + 1, 0),
  'otlp/json (toOtlp + stringify)': () => JSON.stringify(toOtlp(parsed)).length,
};
const n = batch.n;
console.log(`${n} spans`);
for (const [name, f] of Object.entries(cases)) {
  for (let i = 0; i < 5; i++) f();
  const ts = [];
  let bytes = 0;
  for (let i = 0; i < 15; i++) { const a = performance.now(); bytes = f(); ts.push(performance.now() - a); }
  ts.sort((a, b) => a - b);
  const ms = ts[7];
  console.log(`${name.padEnd(32)} ${(ms * 1e6 / n).toFixed(0).padStart(6)} ns/span  ${(bytes / n).toFixed(0).padStart(4)} B/span  ${(bytes / 1e6 / (ms / 1000)).toFixed(0).padStart(5)} MB/s`);
}
