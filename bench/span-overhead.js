// Cost per span: direct call vs Noop vs Record (memory sink, discarded).
// Reports the median of several rounds; prints ns/op.
import { Config, tracer } from '../otel-compact/src/trace.js';

const N = 1_000_000;
const ROUNDS = 7;
let sink = 0;
const work = (x) => (sink += x, x);

const noop = tracer(Config.Noop);
let lines = 0;
const rec = tracer(Config.Record({ write: () => { lines++; } }, { service: 'bench' }));

const cases = {
  direct: () => { for (let i = 0; i < N; i++) work(i); },
  noop: () => { for (let i = 0; i < N; i++) noop.span('x', (s) => work(i)); },
  'noop+attrs': () => { for (let i = 0; i < N; i++) noop.span('x', { i }, (s) => (s.set('k', i), work(i))); },
  record: () => { for (let i = 0; i < N / 10; i++) rec.span('x', { i }, () => work(i)); },
};
const perOp = { direct: N, noop: N, 'noop+attrs': N, record: N / 10 };

for (const [name, f] of Object.entries(cases)) {
  f(); // warm
  const samples = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = process.hrtime.bigint();
    f();
    samples.push(Number(process.hrtime.bigint() - t0) / perOp[name]);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name.padEnd(11)} ${samples[ROUNDS >> 1].toFixed(1).padStart(7)} ns/op  (min ${samples[0].toFixed(1)}, max ${samples.at(-1).toFixed(1)})`);
}
if (sink === -1) console.log(lines);
