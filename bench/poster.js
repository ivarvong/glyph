// Poster benchmark: one examples/posters.js scene (SCENE=, default squiggle) built and rendered to PNG.
//   node bench/poster.js           N=5 untraced runs (median build / render), output hash, then
//                                  one traced run summarised by span (self time first)
//   BASE=<sha256> node bench/poster.js   fail unless the PNG is byte-identical to BASE
// Optimisations must not change a single output byte; the hash is the check.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { tracer, Config, draw } from '../index.js';
import { fileSink } from '../otel-compact/src/node.js';
import { parse, summarize, renderSummary } from '../otel-compact/src/read.js';
process.env.ONLY = 'none'; // load the scene builders without rendering them
const { SCENES } = await import('../examples/posters.js');
const poster = SCENES[process.env.SCENE || 'squiggle'];
if (!poster) { console.error(`SCENE must be one of ${Object.keys(SCENES).join(', ')}`); process.exit(2); }

const N = Number(process.env.N || 5);
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const build = [], render = [], hashes = new Set();
let size = 0;
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const scene = poster();
  const t1 = performance.now();
  const png = new Uint8Array(await new Response(draw.png(scene)).arrayBuffer());
  const t2 = performance.now();
  build.push(t1 - t0); render.push(t2 - t1); size = png.length;
  hashes.add(createHash('sha256').update(png).digest('hex'));
}
const [hash] = hashes;
console.log(`build  median ${med(build).toFixed(0)} ms   [${build.map((x) => x.toFixed(0)).join(' ')}]`);
console.log(`render median ${med(render).toFixed(0)} ms   [${render.map((x) => x.toFixed(0)).join(' ')}]`);
console.log(`png ${size} bytes  sha256 ${hash}${hashes.size > 1 ? `  NONDETERMINISTIC (${hashes.size} hashes)` : ''}`);

mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
const path = new URL('../out/bench-poster.jsonl', import.meta.url).pathname;
const t = tracer(Config.Record(fileSink(path, { maxLines: 4096 }), {}));
await t.span('poster', async (s) => {
  const scene = s.span('build', () => poster());
  await new Response(draw.png(scene, { span: s })).arrayBuffer();
});
await t.flush();
console.log('\n' + renderSummary(summarize(parse(readFileSync(path, 'utf8')).spans).slice(0, 14)));

if (process.env.BASE && process.env.BASE !== hash) { console.error(`\nOUTPUT CHANGED: ${hash} != BASE ${process.env.BASE}`); process.exit(1); }
if (hashes.size > 1) process.exit(1);
