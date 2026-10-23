// Coverage-guided, structure-aware fuzzer for the font pipeline. Zero dependencies: node:inspector
// gives precise block coverage, node:worker_threads gives isolation, timeouts and heap limits.
//
//   node fuzz/fuzz.js [--seconds 120] [--workers N] [--seed 1] [--check]
//   node fuzz/fuzz.js --replay fuzz/findings/*.bin      run saved inputs once and report
//
// Findings (deduplicated, saved as reproducers under fuzz/findings/):
//   throw   any exception escaping the pipeline (the contract is Ok | Err, never a throw)
//   hang    no answer within --timeout ms (worker terminated)
//   oom     worker heap limit hit
//   alloc   one typed array > 64 MiB or > 512 MiB allocated for one input
//   slow    over --slow ms: a CPU amplification candidate
//   diff    our Brotli decoder disagrees with node:zlib on the same stream
//   contract  `undefined` inside a returned value, or a bounds fault outside a guard() scope
import { Worker } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { rng, havoc, woff2Stream, tables, decodeTables, packSfnt, packWoff, packWoff2 } from './mutate.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const SECONDS = Number(arg('seconds', 120)), WORKERS = Number(arg('workers', availableParallelism())), SEED = Number(arg('seed', 1));
const TIMEOUT = Number(arg('timeout', 4000)), SLOW = Number(arg('slow', 1500));
const CHECK = process.argv.includes('--check');
const HERE = new URL('./', import.meta.url).pathname, OUT = `${HERE}findings`, CORPUS = `${HERE}corpus`;
mkdirSync(OUT, { recursive: true }); mkdirSync(CORPUS, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const WORKER_DATA = { allocOne: 64 << 20, allocTotal: 512 << 20 };

// ---- workers --------------------------------------------------------------------------------
function spawn() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { workerData: WORKER_DATA, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 } });
  const slot = { w, busy: null, ready: new Promise((res) => w.once('message', res)) };
  return slot;
}
/** Run one input; resolves with the worker's report or a synthetic hang/oom report. */
function run(slotRef, bytes) {
  return new Promise((resolve) => {
    const slot = slotRef.slot, id = Math.random();
    let done = false;
    const finish = (rep, respawn) => {
      if (done) return; done = true; clearTimeout(timer);
      slot.w.off('message', onMsg); slot.w.off('error', onErr); slot.w.off('exit', onExit);
      if (respawn) { slot.w.terminate().catch(() => {}); slotRef.slot = spawn(); }
      resolve(rep);
    };
    const onMsg = (m) => { if (m.id === id) finish(m, false); };
    const onErr = (e) => finish({ status: /memory/i.test(String(e?.code ?? e)) ? 'oom' : 'throw', detail: `worker: ${String(e?.code ?? e?.message ?? e).slice(0, 160)}`, keys: [] }, true);
    const onExit = () => finish({ status: 'oom', detail: 'worker exited', keys: [] }, true);
    const timer = setTimeout(() => finish({ status: 'hang', detail: `no answer in ${TIMEOUT} ms`, keys: [] }, true), TIMEOUT);
    slot.w.on('message', onMsg); slot.w.once('error', onErr); slot.w.once('exit', onExit);
    slot.w.postMessage({ id, bytes });
  });
}

// ---- findings -------------------------------------------------------------------------------
const findings = new Map(); // dedup key -> { kind, detail, count, file }
function record(kind, detail, bytes) {
  const key = `${kind}|${detail}`;
  const f = findings.get(key);
  if (f) { f.count++; return false; }
  const file = `${OUT}/${kind}-${sha(bytes)}.bin`;
  writeFileSync(file, bytes);
  findings.set(key, { kind, detail, count: 1, file: file.replace(HERE, 'fuzz/') });
  console.log(`  NEW ${kind.padEnd(5)} ${detail}  → ${file.replace(HERE, 'fuzz/')}`);
  return true;
}

// ---- replay mode ----------------------------------------------------------------------------
if (process.argv.includes('--replay')) {
  const files = process.argv.slice(process.argv.indexOf('--replay') + 1).filter((f) => !f.startsWith('--'));
  const ref = { slot: spawn() }; await ref.slot.ready;
  let bad = 0;
  for (const f of files) {
    const rep = await run(ref, readFileSync(f));
    const ok = rep.status === 'ok' && !rep.diff && !rep.contract && (rep.ms || 0) < SLOW;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}  ${rep.status} ${rep.reached ?? ''} ${(rep.ms ?? 0).toFixed(0)} ms ${rep.detail || rep.diff || rep.contract || ''}`);
  }
  await ref.slot.w.terminate();
  process.exit(bad ? 1 : 0);
}

// ---- seeds ----------------------------------------------------------------------------------
// Seeds: the fetched third-party fonts (npm run fetch) and this repo's synthetic fixtures.
const seeds = ['../third_party/fonts/', '../fixtures/'].map((d) => new URL(d, import.meta.url).pathname)
  .flatMap((d) => readdirSync(d).filter((f) => /\.(woff2?|otf|ttf)$/.test(f)).map((f) => readFileSync(d + f)));
// Derived seeds: every plain font re-packed into all three containers (WOFF2 with null transforms).
for (const s of [...seeds]) {
  const d = await decodeTables(s);
  if (!d || !d.tables.every((t) => (t.transform?.tag ?? 'Identity') === 'Identity')) continue;
  const ts = d.tables.map((t) => ({ tag: t.tag, data: t.data })).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  seeds.push(packSfnt(d.flavor, ts), packWoff(d.flavor, ts), packWoff2(d.flavor, ts, rng(7)));
}
const saved = existsSync(CORPUS) ? readdirSync(CORPUS).map((f) => readFileSync(`${CORPUS}/${f}`)) : [];
const corpus = [...seeds, ...saved].map((b) => ({ bytes: new Uint8Array(b), picks: 0 }));

// ---- loop -----------------------------------------------------------------------------------
const seen = new Set();
const r = rng(SEED);
let execs = 0, accepted = 0;
const counts = {};
const slots = Array.from({ length: WORKERS }, () => ({ slot: spawn() }));
await Promise.all(slots.map((s) => s.slot.ready));
// Seeds first: they define baseline coverage and must themselves be clean.
for (const c of corpus) {
  const rep = await run(slots[0], c.bytes);
  for (const k of rep.keys ?? []) seen.add(k);
  if (rep.status !== 'ok') record(rep.status, rep.detail, c.bytes);
}
console.log(`seeds: ${corpus.length} inputs, ${seen.size} coverage keys; fuzzing ${SECONDS}s on ${WORKERS} workers`);

async function mutate() {
  // Favour inputs that found coverage recently (newer = later in the array) and rarely picked ones.
  const i = r.chance(0.5) ? corpus.length - 1 - r.int(Math.min(32, corpus.length)) : r.int(corpus.length);
  const parent = corpus[i]; parent.picks++;
  const k = r.int(100);
  if (k < 35) return { op: 'havoc', bytes: havoc(parent.bytes, r) };
  if (k < 65) { const b = woff2Stream(parent.bytes, r); if (b) return { op: 'woff2', bytes: b }; }
  if (k < 95 || true) {
    const donor = r.chance(0.15) ? r.pick(corpus).bytes : undefined;
    const b = await tables(parent.bytes, r, donor).catch(() => null);
    if (b) return { op: donor ? 'splice' : 'table', bytes: b };
  }
  return { op: 'havoc', bytes: havoc(parent.bytes, r) };
}

const end = Date.now() + SECONDS * 1000;
let lastReport = Date.now();
async function lane(ref) {
  while (Date.now() < end) {
    const { op, bytes } = await mutate();
    const rep = await run(ref, bytes);
    execs++; counts[op] = (counts[op] ?? 0) + 1;
    if (rep.status !== 'ok') record(rep.status, rep.detail, bytes);
    else if (rep.diff) record('diff', rep.diff.replace(/\d+/g, 'N'), bytes);
    else if (rep.contract) record('contract', rep.contract.replace(/\d+/g, 'N'), bytes);
    else if (rep.ms > SLOW) record('slow', `${op} input ${(rep.ms / 100).toFixed(0)}00 ms reached ${rep.reached}`, bytes);
    let fresh = 0;
    for (const k of rep.keys ?? []) if (!seen.has(k)) { seen.add(k); fresh++; }
    if (fresh && rep.status === 'ok') { corpus.push({ bytes, picks: 0 }); accepted++; writeFileSync(`${CORPUS}/${sha(bytes)}.bin`, bytes); }
    if (Date.now() - lastReport > 15000) {
      lastReport = Date.now();
      const byKind = {}; for (const f of findings.values()) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      console.log(`  ${execs} execs (${(execs / ((SECONDS * 1000 - (end - Date.now())) / 1000)).toFixed(0)}/s)  corpus ${corpus.length}  coverage ${seen.size}  findings ${JSON.stringify(byKind)}`);
    }
  }
}
await Promise.all(slots.map(lane));
await Promise.all(slots.map((s) => s.slot.w.terminate()));
const summary = [...findings.values()];
writeFileSync(`${OUT}/index.json`, JSON.stringify(summary, null, 1));
console.log(`\n${execs} execs, ${accepted} new corpus entries, ${seen.size} coverage keys, ops ${JSON.stringify(counts)}`);
console.log(`${summary.length} unique findings${summary.length ? ':' : ''}`);
for (const f of summary.sort((a, b) => a.kind.localeCompare(b.kind))) console.log(`  ${f.kind.padEnd(5)} ×${String(f.count).padEnd(4)} ${f.detail}\n        ${f.file}`);
if (CHECK && summary.length) process.exitCode = 1;
