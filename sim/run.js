// Local Workers simulator driver. Runs the example workers, unchanged, in real workerd (pinned),
// wired to models of R2, Workers Cache and the internet (see build.js), and measures them from
// outside the process: latency, time to first byte, status mix, peak RSS, CPU per request.
//
//   node sim/run.js                       all scenarios
//   node sim/run.js cached cold           some of them
//   node sim/run.js --quick               fewer requests
//
// What is real: the runtime (V8 isolate, Web APIs, streams, fetch, RPC, hang detection), the
// example code, the library. What is modelled: R2, Workers Cache, the internet (workers/*.js),
// and the production limits, which workerd does not enforce locally. They are checked here against
// the measurements: 128 MB per isolate (shared by concurrent requests), and CPU time per request.
// Not modelled: production's clock (it only advances across I/O; locally it advances during CPU),
// multiple isolates per colo, tiered cache, eviction under memory pressure.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildApp } from './build.js';
import { tcpChaos } from './chaos/tcp.js';
import { logKey } from './chaos/plan.js';
import { decodePng } from '../verify/pngdecode.js';

const SIM = new URL('./', import.meta.url).pathname;
const WORKERD = `${SIM}node_modules/.bin/workerd`;
const QUICK = process.argv.includes('--quick');
const CHECK = process.argv.includes('--check');
const ISOLATE_MB = 128;
const TICK_MS = 10; // /proc CPU ticks at CLK_TCK = 100
const HAS_PROC = existsSync('/proc/self/stat');

// ---- process control and /proc sampling ------------------------------------------------------
const V8_FLAGS = ['--expose-gc', ...(process.env.SIM_V8_FLAGS || '').split(' ').filter(Boolean)];

/**
 * Per-isolate memory, read from inside real workerd over its inspector (Runtime.getHeapUsage):
 * JS heap used + ArrayBuffer backing stores, which is what an isolate's memory is made of.
 * Process RSS overstates it: five isolates share the process and the allocator keeps freed pages.
 */
async function inspect(inspPort, target) {
  const ws = new WebSocket(`ws://127.0.0.1:${inspPort}/${target}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const f = pend.get(m.id); if (f) { pend.delete(m.id); f(m.result); } };
  const call = (method) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method })); });
  return {
    /** bytes: heap used + backing stores */
    usage: async () => { const u = await call('Runtime.getHeapUsage'); return { heap: u.usedSize, buffers: u.backingStorageSize, total: u.usedSize + u.backingStorageSize }; },
    close: () => ws.close(),
  };
}

async function boot(app, port, adminPort, { isolates = 1, chaos = false } = {}) {
  // Chaos: the TCP fault proxy starts first (its port goes into the config); workerd's net
  // worker gets its own socket for the proxy to forward to.
  const tcp = chaos ? await tcpChaos({ upstreamPort: port + 50 }) : null;
  const { config, mains, ports } = await buildApp(app, { port, adminPort, v8Flags: V8_FLAGS, isolates, chaos: tcp ? { tcpPort: tcp.port, netPort: port + 50 } : null });
  const inspPort = port + 1000;
  const p = spawn(WORKERD, ['serve', config, '--experimental', `--inspector-addr=127.0.0.1:${inspPort}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; p.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${adminPort}/stats`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  const proc = (f) => readFileSync(`/proc/${p.pid}/${f}`, 'utf8');
  // Process CPU and RSS come from Linux /proc; elsewhere (macOS) they are NaN: reported as unmeasured,
  // never as zero. Isolate memory comes from the inspector and is measured everywhere.
  const kb = (k) => (HAS_PROC ? Number(new RegExp(`${k}:\\s+(\\d+)`).exec(proc('status'))[1]) : NaN);
  const cpu = () => { if (!HAS_PROC) return NaN; const f = proc('stat').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) * TICK_MS; };
  // ns-precision CPU of every thread in the process (sum of /proc/<pid>/task/*/schedstat field 1).
  const cpuNs = () => { if (!HAS_PROC) return NaN; let t = 0; for (const tid of readdirSync(`/proc/${p.pid}/task`)) { try { t += Number(readFileSync(`/proc/${p.pid}/task/${tid}/schedstat`, 'utf8').split(' ')[0]); } catch { /* thread exited */ } } return t; };
  let peak = 0;
  const sampler = setInterval(() => { try { peak = Math.max(peak, kb('VmRSS')); } catch { /* exited */ } }, 5);
  // Isolate sampling: the inspector answers between tasks, so a sample can land mid-request
  // (between awaits) but not inside one synchronous stretch. Peaks are therefore lower bounds.
  // One inspector session per app isolate; the reported peak is the largest single isolate,
  // since the 128 MB limit is per isolate.
  const insps = await Promise.all(mains.map((m) => inspect(inspPort, m)));
  let iso = { peak: 0, samples: 0, stop: false };
  const isoLoop = (async () => { while (!iso.stop) { for (const insp of insps) { const u = await insp.usage(); iso.peak = Math.max(iso.peak, u.total); } iso.samples++; await new Promise((r) => setTimeout(r, 10)); } })();
  const live = async () => {
    // Two collections with pauses: V8 frees ArrayBuffer backing stores on a background sweeper.
    for (let k = 0; k < 2; k++) { await Promise.all(ports.map((pp) => fetch(`http://127.0.0.1:${pp}/__sim/gc`).then((r) => r.text()))); await new Promise((r) => setTimeout(r, 400)); }
    const us = await Promise.all(insps.map((i) => i.usage()));
    return us.reduce((a, b) => (b.total > a.total ? b : a));
  };
  return {
    isoUsage: async () => (await Promise.all(insps.map((i) => i.usage()))).reduce((a, b) => (b.total > a.total ? b : a)), isoPeak: () => iso.peak, isoResetPeak: () => { iso.peak = 0; }, isoLive: live,
    url: `http://127.0.0.1:${port}`, urls: ports.map((pp) => `http://127.0.0.1:${pp}`), admin: `http://127.0.0.1:${adminPort}`,
    cpuNs, rssMb: () => kb('VmRSS') / 1024, hwmMb: () => Math.max(kb('VmHWM'), peak) / 1024, cpuMs: cpu,
    resetPeak: () => { peak = 0; }, sampledPeakMb: () => peak / 1024,
    log: () => log, alive: () => p.exitCode === null,
    tcp,
    plan: async (p) => { await fetch(`http://127.0.0.1:${adminPort}/chaos/plan`, { method: 'POST', body: JSON.stringify(p) }); if (tcp) tcp.setPlan(p); },
    chaosLog: async () => [...(await (await fetch(`http://127.0.0.1:${adminPort}/chaos/log`)).json()), ...(tcp ? tcp.log() : [])],
    stop: async () => { if (tcp) await tcp.close(); iso.stop = true; await isoLoop; for (const i of insps) i.close(); clearInterval(sampler); if (p.exitCode === null) { const exited = new Promise((r) => p.once('exit', r)); p.kill('SIGTERM'); const t = setTimeout(() => p.kill('SIGKILL'), 2000); await exited; clearTimeout(t); } },
  };
}
const admin = async (w, path, body) => (await fetch(`${w.admin}${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();

// ---- load ---------------------------------------------------------------------------------------
/** Run `reqs` (paths) at `concurrency`; per request: status, ms to headers, ms total, bytes. */
async function load(w, reqs, concurrency) {
  const out = new Array(reqs.length);
  // At concurrency 1 each request's CPU is the process's CPU delta around it (ns, all threads):
  // a per-request distribution, comparable with the Workers CPU limits. Includes the small cost
  // of the model isolates and the inspector sampler.
  const perReqCpu = concurrency === 1;
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let i; (i = next++) < reqs.length;) {
      const t = performance.now();
      const c0 = perReqCpu ? w.cpuNs() : 0;
      try {
        const base = w.urls.length > 1 ? w.urls[(i * 2654435761 >>> 0) % w.urls.length] : w.url; // spread across isolates
        // connection: close — reusing keep-alive connections under sustained load races workerd
        // closing them (ECONNRESET 17–42 ms after send; 0 failures with close). In production
        // the edge, not a client, talks to the isolate, so that race is the driver's, not the app's.
        const res = await fetch(`${base}${reqs[i].path}`, { headers: { connection: 'close' } });
        const ttfb = performance.now() - t;
        const body = new Uint8Array(await res.arrayBuffer());
        out[i] = { status: res.status, ttfb, ms: performance.now() - t, bytes: body.length, body, want: reqs[i].want, cpuMs: perReqCpu ? (w.cpuNs() - c0) / 1e6 : -1 };
      } catch (e) { out[i] = { status: 0, ttfb: 0, ms: performance.now() - t, bytes: 0, err: `${e} cause: ${e.cause ? (e.cause.code || e.cause.message) : ''}`, want: reqs[i].want }; }
    }
  }));
  return { results: out, wallMs: performance.now() - t0 };
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const zipf = (n, s, rnd) => { const w = Array.from({ length: n }, (_, k) => 1 / (k + 1) ** s); const t = w.reduce((a, b) => a + b); return () => { let r = rnd() * t; for (let k = 0; k < n; k++) if ((r -= w[k]) <= 0) return k; return n - 1; }; };
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const WORDS = 'edge cache render glyph workers stream isolate deflate brotli shape kern ligature office waffle quartz fjord sphinx zephyr'.split(' ');
const phrase = (k) => { const r = rng(k + 1); return Array.from({ length: 1 + Math.floor(r() * 4) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' '); };

async function report(name, conc, w, base, r, extra = {}) {
  const isoPeakMb = w.isoPeak() / 2 ** 20;
  const liveU = await w.isoLive();
  const isoLiveMb = liveU.total / 2 ** 20;
  const ok = r.results.filter((x) => x.status === 200);
  const ms = r.results.map((x) => x.ms), tt = r.results.map((x) => x.ttfb);
  const status = {}; for (const x of r.results) status[x.status] = (status[x.status] || 0) + 1;
  const wrong = r.results.filter((x) => x.want && x.status !== x.want);
  const row = {
    scenario: name, concurrency: conc, requests: r.results.length, rps: Math.round(r.results.length / (r.wallMs / 1000)),
    p50: +q(ms, 0.5).toFixed(1), p95: +q(ms, 0.95).toFixed(1), p99: +q(ms, 0.99).toFixed(1), ttfbP50: +q(tt, 0.5).toFixed(1),
    status, unexpected: wrong.length,
    rssBaseMb: +base.rss.toFixed(1), rssPeakMb: +w.sampledPeakMb().toFixed(1), rssGrowthMb: +(w.sampledPeakMb() - base.rss).toFixed(1),
    cpuMsPerReq: +((w.cpuMs() - base.cpu) / r.results.length).toFixed(2),
    isolatePeakMb: +isoPeakMb.toFixed(1), isolateLiveMb: +isoLiveMb.toFixed(1),
    ...(conc === 1 ? (() => { const c = r.results.map((x) => x.cpuMs); return { cpuP50: +q(c, 0.5).toFixed(2), cpuP99: +q(c, 0.99).toFixed(2), cpuMax: +Math.max(...c).toFixed(2), overFreeLimit: c.filter((x) => x > 10).length }; })() : {}),
    okBytesP50: ok.length ? q(ok.map((x) => x.bytes), 0.5) : 0, ...extra,
  };
  const verdict = isoPeakMb > ISOLATE_MB ? `OVER ${ISOLATE_MB} MB` : `${Math.round((100 * isoPeakMb) / ISOLATE_MB)}% of ${ISOLATE_MB} MB`;
  console.log(`${name.padEnd(8)} c=${String(conc).padEnd(3)} ${String(row.rps).padStart(5)} rps  p50 ${String(row.p50).padStart(6)}  p99 ${String(row.p99).padStart(7)} ms  ttfb ${String(row.ttfbP50).padStart(5)}  ` +
    `cpu ${String(row.cpuMsPerReq).padStart(6)} ms/req  isolate peak ${String(row.isolatePeakMb).padStart(5)} MB (${verdict}), live ${String(row.isolateLiveMb).padStart(4)} MB  ${JSON.stringify(status)}${wrong.length ? `  UNEXPECTED ${wrong.length}` : ''}`);
  if (conc === 1) console.log(`         per-request CPU p50 ${row.cpuP50} ms, p99 ${row.cpuP99} ms, max ${row.cpuMax} ms; ${row.overFreeLimit}/${r.results.length} over the Free plan's 10 ms`);
  if (wrong.length) for (const x of wrong.slice(0, 3)) console.log(`    want ${x.want} got ${x.status} ${x.err || new TextDecoder().decode(x.body.slice(0, 120))}`);
  return row;
}

// ---- scenarios ------------------------------------------------------------------------------------
const N = QUICK ? 300 : 1500;
const SCENARIOS = {
  // The generic spec renderer (worker/src/index.js) in workerd: every spec at DPR 1 and 3, cold
  // then warm, one at a time (per-request CPU and isolate peak), each PNG checked byte for byte
  // against the same app run in Node; then a burst of concurrent cold renders against the gate.
  async spec(port) {
    const ROOT = new URL('../', import.meta.url).pathname;
    const { createRenderer } = await import('../worker/src/app.js');
    const MIRROR = /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[0-9a-f]{40}\/(.*)$/;
    const { FIXTURE_FONTS } = await import('./build.js');
    const fontFile = (url) => { const m = MIRROR.exec(url); return url in FIXTURE_FONTS ? `${ROOT}${FIXTURE_FONTS[url]}` : m ? `${ROOT}conform/.ext/gfonts/${m[1].split('/').map(decodeURIComponent).join('/')}` : ''; };
    const fileOf = (n) => (readdirSync(`${ROOT}examples/specs`).includes(n) ? `${ROOT}examples/specs/${n}` : `${ROOT}out/specs/${n}`);
    const every = [...readdirSync(`${ROOT}examples/specs`), ...(existsSync(`${ROOT}out/specs`) ? readdirSync(`${ROOT}out/specs`) : [])].filter((f) => f.endsWith('.json'));
    // Specs whose fonts are not on disk (no conform/.ext/gfonts checkout) are skipped, and said so.
    const runnable = (n) => Object.values(JSON.parse(readFileSync(fileOf(n), 'utf8')).fonts || {}).every((r) => { const f = fontFile(typeof r === 'string' ? r : r.url); return f && existsSync(f); });
    const names = every.filter(runnable), skipped = every.filter((n) => !runnable(n));
    if (skipped.length) console.log(`  spec: ${skipped.length} of ${every.length} specs skipped, their fonts are not on disk (conform/setup.sh): ${skipped.join(', ')}`);
    const localFetch = async (url) => {
      const f = fontFile(url);
      if (f) return new Response(readFileSync(f));
      const s2 = /^https:\/\/specs\.example\.com\/(.*)$/.exec(url);
      return s2 ? new Response(readFileSync(fileOf(s2[1]))) : new Response('no', { status: 404 });
    };
    const local = createRenderer();
    const localSha = async (path) => createHash('sha256').update(new Uint8Array(await (await local.handle(new Request(`https://x${path}`), { fetch: localFetch, cached: null, bucket: null, specs: null, defer: () => {}, tracer: (await import('../otel-compact/src/trace.js')).NOOP_TRACER })).arrayBuffer())).digest('hex');
    const w = await boot('render', port, port + 1);
    const rows = [];
    const dprs = QUICK ? [1] : [1, 3];
    for (const dpr of dprs) {
      for (const n of names) {
        const path = `/render?spec=${encodeURIComponent(`https://specs.example.com/${n}`)}&dpr=${dpr}`;
        w.isoResetPeak();
        const c0 = w.cpuNs(), t0 = performance.now();
        const res = await fetch(`${w.url}${path}`, { headers: { connection: 'close' } });
        const bytes = new Uint8Array(await res.arrayBuffer());
        const ms = performance.now() - t0, cpuMs = (w.cpuNs() - c0) / 1e6, peakMb = w.isoPeak() / 2 ** 20;
        const t1 = performance.now();
        const warm = await fetch(`${w.url}${path}`, { headers: { connection: 'close' } });
        const warmBytes = new Uint8Array(await warm.arrayBuffer());
        const warmMs = performance.now() - t1;
        const sha = createHash('sha256').update(bytes).digest('hex');
        const same = res.status === 200 && sha === (await localSha(path)) && createHash('sha256').update(warmBytes).digest('hex') === sha;
        rows.push({ spec: n.replace('.json', ''), dpr, status: res.status, ms: Math.round(ms), cpuMs: Math.round(cpuMs), isolatePeakMb: +peakMb.toFixed(1), kib: Math.round(bytes.length / 1024), warmMs: +warmMs.toFixed(1), sameAsNode: same });
        if (res.status !== 200) console.log(`    ${n} dpr ${dpr}: ${res.status} ${new TextDecoder().decode(bytes.slice(0, 200))}`);
      }
    }
    console.table(rows);
    const live = await w.isoLive();
    const st = await admin(w, '/stats');
    const h0 = await (await fetch(`${w.url}/healthz`, { headers: { connection: 'close' } })).json();
    const mb = (x) => (x / 2 ** 20).toFixed(1);
    console.log(`isolate live after all: ${mb(live.total)} MB = heap ${mb(live.heap)} + buffers ${mb(live.buffers)}; caches by their own accounting: fonts ${mb(h0.fonts.bytes)} MB (${h0.fonts.entries} parsed), outlines ${mb(h0.outlines.bytes)} MB, renders L1 ${mb(h0.renders.bytes)} MB (${h0.renders.entries}); Workers Cache ${st.wc.hits} hits / ${st.wc.misses} misses; R2 puts ${st.r2.puts}`);
    // Live peak *during* renders: while requests are in flight, repeatedly collect garbage in the
    // isolate (between its tasks: a render yields between PNG bands) and read heap + buffers. The
    // maximum is the live set at the worst moment observed: what a 128 MB limit actually tests.
    const livePeak = async (work) => {
      let done = false, peak = 0, samples = 0;
      const p = work().finally(() => { done = true; });
      while (!done) {
        await fetch(`${w.url}/__sim/gc`, { headers: { connection: 'close' } }).then((r) => r.text());
        const u = await w.isoUsage(); samples++;
        if (u.total > peak) peak = u.total;
      }
      return { result: await p, peakMb: +(peak / 2 ** 20).toFixed(1), samples };
    };
    // Burst: every spec at once, uncached (a fresh dpr), so all must render concurrently.
    w.isoResetPeak();
    const burstRun = await livePeak(() => Promise.all(names.map((n) => fetch(`${w.url}/render?spec=${encodeURIComponent(`https://specs.example.com/${n}`)}&dpr=2.5`, { headers: { connection: 'close' } })
      .then(async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength })))));
    const burst = burstRun.result;
    console.log(`burst: live peak during ${burstRun.peakMb} MB (${burstRun.samples} GC'd samples)`);
    const statuses = {}; for (const b of burst) statuses[b.status] = (statuses[b.status] || 0) + 1;
    const health = await (await fetch(`${w.url}/healthz`, { headers: { connection: 'close' } })).json();
    console.log(`burst of ${names.length} cold renders: ${JSON.stringify(statuses)}; isolate peak ${(w.isoPeak() / 2 ** 20).toFixed(1)} MB; stream ${JSON.stringify(health.stream)}; hop ${JSON.stringify(health.hop)}`);
    await w.stop();
    const bad = rows.filter((r) => r.status !== 200 || !r.sameAsNode || r.isolatePeakMb > ISOLATE_MB);
    return [{ scenario: 'spec', rows, burst: statuses, failures: bad.length, skipped: skipped.length }];
  },
  // Steady state: Zipf over 300 phrases × 3 sizes through isolate memory → Workers Cache → R2.
  async cached(port) {
    const rows = [];
    for (const conc of [1, 8, 32]) {
      const w = await boot('cached', port, port + 1);
      await fetch(`${w.url}/?t=warm`).then((r) => r.arrayBuffer());
      const base = { rss: w.rssMb(), cpu: w.cpuMs() }; w.resetPeak(); w.isoResetPeak();
      const pick = zipf(300, 1, rng(conc)), size = rng(99);
      const reqs = Array.from({ length: N }, () => ({ path: `/?t=${encodeURIComponent(phrase(pick()))}&s=${[48, 96, 192][Math.floor(size() * 3)]}`, want: 200 }));
      const r = await load(w, reqs, conc);
      const st = await admin(w, '/stats');
      rows.push(await report('cached', conc, w, base, r, { wc: st.wc, r2: st.r2 }));
      console.log(`         Workers Cache hits ${st.wc.hits} / misses ${st.wc.misses}; R2 gets ${st.r2.gets} hits ${st.r2.hits} puts ${st.r2.puts}`);
      await w.stop();
    }
    return rows;
  },
  // A colo: K isolates, each with its own memory tier, sharing Workers Cache and R2. Same Zipf mix
  // as `cached`. Renders = R2 puts (each one is a miss at every tier).
  async colo(port) {
    const rows = [];
    for (const isolates of [1, 4, 8]) {
      const w = await boot('cached', port, port + 1, { isolates });
      for (const u of w.urls) await fetch(`${u}/?t=warm`).then((r) => r.arrayBuffer());
      const base = { rss: w.rssMb(), cpu: w.cpuMs() }; w.resetPeak(); w.isoResetPeak();
      const pick = zipf(300, 1, rng(7)), size = rng(98);
      const reqs = Array.from({ length: N }, () => ({ path: `/?t=${encodeURIComponent(phrase(pick()))}&s=${[48, 96, 192][Math.floor(size() * 3)]}`, want: 200 }));
      const r = await load(w, reqs, 32);
      const st = await admin(w, '/stats');
      rows.push(await report(`colo×${isolates}`, 32, w, base, r, { isolates, wc: st.wc, r2: st.r2 }));
      console.log(`         ${isolates} isolates: Workers Cache ${st.wc.hits} hits / ${st.wc.misses} misses; renders ${st.r2.puts}`);
      await w.stop();
    }
    return rows;
  },
  // Worst case for memory: every request is unique (no cache helps) and large.
  async cold(port) {
    const rows = [];
    for (const conc of [1, 8, 32, 64]) {
      const w = await boot('cached', port, port + 1);
      await fetch(`${w.url}/?t=warm`).then((r) => r.arrayBuffer());
      const base = { rss: w.rssMb(), cpu: w.cpuMs() }; w.resetPeak(); w.isoResetPeak();
      const reqs = Array.from({ length: QUICK ? 100 : 400 }, (_, i) => ({ path: `/?t=${encodeURIComponent(`${phrase(i)} ${i} ${phrase(i + 7)}`)}&s=512`, want: 200 }));
      rows.push(await report('cold', conc, w, base, await load(w, reqs, conc)));
      await w.stop();
    }
    return rows;
  },
  // User-supplied fonts, with a hostile mix and an unreliable network (5% 503s, +20 ms).
  async fetch(port) {
    const w = await boot('fetch', port, port + 1);
    await admin(w, '/faults', { net: { latencyMs: 20, errorRate: 0.05 } });
    const base = { rss: w.rssMb(), cpu: w.cpuMs() }; w.resetPeak(); w.isoResetPeak();
    const r = rng(5);
    const mix = [
      [0.55, () => ({ path: `/?font=https://fonts.gstatic.com/inter.woff2&t=${encodeURIComponent(phrase(Math.floor(r() * 500)))}` })],
      [0.25, () => ({ path: `/?font=https://cdn.jsdelivr.net/serif.woff2&t=${encodeURIComponent(phrase(Math.floor(r() * 500)))}` })],
      [0.05, () => ({ path: '/?font=https://evil.example/x.woff2', want: 422 })],
      [0.05, () => ({ path: '/?font=https://fonts.gstatic.com/junk.woff2', want: 422 })],
      [0.05, () => ({ path: '/?font=https://fonts.gstatic.com/hostile.woff2&s=24&t=Hfiffl%20AVTo%200123%20office', want: 413 })],
      [0.05, () => ({ path: '/?font=https://fonts.gstatic.com/huge.woff2', want: 422 })],
    ];
    const reqs = Array.from({ length: QUICK ? 200 : 800 }, () => { let x = r(); for (const [p, f] of mix) if ((x -= p) <= 0) return f(); return mix[0][1](); });
    const res = await load(w, reqs, 16);
    // With 5% injected 503s, any request that reaches the network may correctly answer 502.
    for (const x of res.results) if (x.status === 502) x.want = 502; else if (!x.want) x.want = 200;
    const st = await admin(w, '/stats');
    const row = await report('fetch', 16, w, base, res, { net: st.net, r2: st.r2 });
    console.log(`         network requests ${st.net.requests} for ${res.results.length} app requests; R2 font bytes cached ${st.r2.objects} objects`);
    await w.stop();
    return [row];
  },
  // Faults: R2 fails half its calls (+30 ms), the network fails 30% of fetches. Contract: a
  // failing tier is a miss, never an error page; an upstream failure is a 502/504, never a 500.
  async faults(port) {
    const rows = [];
    {
      const w = await boot('cached', port, port + 1);
      await admin(w, '/faults', { r2: { failRate: 0.5, latencyMs: 30 } });
      const base = { rss: w.rssMb(), cpu: w.cpuMs() }; w.resetPeak(); w.isoResetPeak();
      const pick = zipf(100, 1, rng(3));
      const reqs = Array.from({ length: QUICK ? 150 : 500 }, () => ({ path: `/?t=${encodeURIComponent(phrase(pick()))}`, want: 200 }));
      const r = await load(w, reqs, 8);
      const st = await admin(w, '/stats');
      rows.push(await report('r2-fail', 8, w, base, r, { r2: st.r2 }));
      console.log(`         R2: ${st.r2.failed} failed calls of ${st.r2.gets + st.r2.puts}; every response 200 = failures degraded to misses`);
      await w.stop();
    }
    {
      const w = await boot('fetch', port, port + 1);
      await admin(w, '/faults', { net: { errorRate: 0.3 } });
      const base = { rss: w.rssMb(), cpu: w.cpuMs() }; w.resetPeak(); w.isoResetPeak();
      const r0 = rng(11);
      // Distinct URLs per request, so every one hits the network (no byte cache can hide a fault).
      const reqs = Array.from({ length: QUICK ? 100 : 300 }, (_, i) => ({ path: `/?font=https://fonts.gstatic.com/inter.woff2%3Fv%3D${i}&t=${encodeURIComponent(phrase(Math.floor(r0() * 99)))}` }));
      const r = await load(w, reqs, 8);
      for (const x of r.results) x.want = x.status === 502 ? 502 : 200; // either is correct; anything else is not
      const st = await admin(w, '/stats');
      rows.push(await report('net-fail', 8, w, base, r, { net: st.net }));
      await w.stop();
    }
    return rows;
  },
  // Cold start: a fresh process (new isolates), then its first request. Startup CPU is the whole
  // process to ready (all isolates' module evaluation); first-request CPU includes font parsing.
  async coldstart(port) {
    const rows = [];
    for (const app of ['cached', 'fetch']) {
      const samples = [];
      for (let k = 0; k < (QUICK ? 3 : 6); k++) {
        const t = performance.now();
        const w = await boot(app, port, port + 1);
        const ready = performance.now() - t, bootCpu = w.cpuNs() / 1e6;
        const c0 = w.cpuNs(), t1 = performance.now();
        const path = app === 'cached' ? '/?t=Cold%20start' : '/?font=https://fonts.gstatic.com/inter.woff2&t=Cold%20start';
        const res = await fetch(`${w.url}${path}`); await res.arrayBuffer();
        samples.push({ status: res.status, readyMs: ready, bootCpuMs: bootCpu, firstMs: performance.now() - t1, firstCpuMs: (w.cpuNs() - c0) / 1e6 });
        await w.stop();
      }
      const med = (k) => +q(samples.map((x) => x[k]), 0.5).toFixed(1);
      const row = { scenario: 'coldstart', app, runs: samples.length, status: [...new Set(samples.map((x) => x.status))], processReadyMs: med('readyMs'), bootCpuMs: med('bootCpuMs'), firstRequestMs: med('firstMs'), firstRequestCpuMs: med('firstCpuMs') };
      console.log(`coldst.  ${app.padEnd(7)} process ready ${row.processReadyMs} ms (${row.bootCpuMs} ms CPU, 5 isolates)  first request ${row.firstRequestMs} ms, ${row.firstRequestCpuMs} ms CPU  status ${row.status}`);
      rows.push(row);
    }
    return rows;
  },
  // Chaos: seeded fault plans through the chaos worker (HTTP, RPC, the Workers Cache hop) and
  // the TCP proxy (real sockets). Each plan states its contract; the driver checks every response.
  async chaos(port) {
    const rows = [];
    const { loadFont, renderText, flattenCache } = await import('../index.js');
    const { pngJob } = await import('../cache/index.js');
    const inter = (await loadFont(readFileSync(new URL('../third_party/fonts/inter-latin-400.woff2', import.meta.url)))).value;
    const outlines = flattenCache({ maxBytes: 8 << 20 });
    const refs = new Map();
    /** The PNG Node renders for the same request (parity is checked separately). */
    const reference = async (text, size) => {
      const k = `${size}|${text}`;
      if (!refs.has(k)) { const r = await renderText([{ font: inter, fontKey: 'inter', text, size }], { targets: [] }); refs.set(k, (await pngJob(r.value.scene, { outlines }).make()).value); }
      return refs.get(k);
    };
    const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
    const lognormal = (median, p99) => ({ median, p99 });
    const R = QUICK ? 120 : 400;
    const PLANS = [
      // ---- cached app: R2 and the Workers Cache hop ----------------------------------------
      { name: 'r2-flaky', app: 'cached', allow: [200], rules: [
        { id: 'get-err', at: 'r2', match: { method: 'get' }, when: { rate: 0.3 }, fault: { kind: 'error' } },
        { id: 'put-err', at: 'r2', match: { method: 'put' }, when: { rate: 0.2 }, fault: { kind: 'error' } },
        { id: 'slow', at: 'r2', when: { rate: 1 }, fault: { kind: 'delay', ms: lognormal(15, 250) } }] },
      { name: 'r2-lost', app: 'cached', allow: [200], rules: [
        { id: 'drop', at: 'r2', match: { method: 'put' }, when: { rate: 0.5 }, fault: { kind: 'drop' } },
        { id: 'missing', at: 'r2', match: { method: 'get' }, when: { rate: 0.2 }, fault: { kind: 'missing' } }] },
      // R2 is only read when memory and Workers Cache both miss: warm it through one isolate,
      // purge Workers Cache, then read through the others with corruption on.
      { name: 'r2-corrupt', app: 'cached', allow: [200], exact: true, isolates: 4, warm: true, rules: [
        { id: 'flip', at: 'r2', match: { method: 'get' }, when: { rate: 0.3 }, fault: { kind: 'corrupt', flips: 4 } }] },
      { name: 'wc-down', app: 'cached', allow: [200], rules: [
        { id: 'wc-err', at: 'wc', when: { rate: 0.3 }, fault: { kind: 'error' } },
        { id: 'wc-5xx', at: 'wc', when: { rate: 0.1 }, fault: { kind: 'status', status: 503 } }] },
      { name: 'wc-corrupt', app: 'cached', allow: [200], exact: true, rules: [
        { id: 'flip', at: 'wc', when: { rate: 0.2 }, fault: { kind: 'corrupt', flips: 4 } }] },
      { name: 'slow-tiers', app: 'cached', allow: [200], maxMs: 8000, rules: [
        { id: 'r2-slow', at: 'r2', when: { rate: 1 }, fault: { kind: 'delay', ms: lognormal(30, 1500) } },
        { id: 'wc-slow', at: 'wc', when: { rate: 1 }, fault: { kind: 'delay', ms: lognormal(20, 800) } }] },
      // ---- fetch app: the network, HTTP and sockets ---------------------------------------
      { name: 'net-flaky', app: 'fetch', allow: [200, 502], replay: true, rules: [
        { id: 'err', at: 'net', when: { rate: 0.15 }, fault: { kind: 'error' } },
        { id: '503', at: 'net', when: { rate: 0.1 }, fault: { kind: 'status', status: 503 } },
        { id: 'lat', at: 'net', when: { rate: 1 }, fault: { kind: 'delay', ms: lognormal(25, 600) } }] },
      { name: 'tcp-chaos', app: 'fetch', allow: [200, 502], rules: [
        { id: 'refuse', at: 'tcp', when: { rate: 0.05 }, fault: { kind: 'refuse' } },
        { id: 'reset', at: 'tcp', when: { rate: 0.1 }, fault: { kind: 'reset', afterBytes: 3000 } },
        { id: 'trunc', at: 'tcp', when: { rate: 0.1 }, fault: { kind: 'truncate', afterBytes: 9000 } },
        { id: 'drip', at: 'tcp', when: { rate: 0.1 }, fault: { kind: 'drip', chunk: 1024, intervalMs: 3 } }] },
      { name: 'net-corrupt', app: 'fetch', allow: [200, 422], recover: true, rules: [
        { id: 'flip', at: 'net', when: { rate: 0.3 }, fault: { kind: 'corrupt', flips: 6 } }] },
      { name: 'stall', app: 'fetch', allow: [200, 504], maxMs: 12_000, small: true, rules: [
        { id: 'stall', at: 'tcp', when: { rate: 0.1 }, fault: { kind: 'stall' } }] },
    ];
    for (const plan of PLANS) {
      const w = await boot(plan.app, port, port + 1, { chaos: true, isolates: plan.isolates || 1 });
      const seeded = { seed: 7, rules: plan.rules };
      let view = w;
      const base = { rss: w.rssMb(), cpu: w.cpuMs() }; w.resetPeak(); w.isoResetPeak();
      const r0 = rng(13);
      const n = plan.small ? (QUICK ? 30 : 60) : R;
      const reqs = Array.from({ length: n }, (_, i) => {
        const text = phrase(Math.floor(r0() * (plan.app === 'cached' ? 60 : 1e6)));
        return plan.app === 'cached'
          ? { path: `/?t=${encodeURIComponent(text)}`, text, size: 96 }
          // A distinct font URL per request (the query differs), so every request meets the network.
          : { path: `/?font=https://fonts.gstatic.com/inter.woff2%3Fv%3D${plan.name}${i}&t=${encodeURIComponent(text)}` };
      });
      if (plan.warm) {
        await w.plan({ seed: 7, rules: [] });
        await load({ ...w, url: w.urls[0], urls: [w.urls[0]] }, reqs, 8);
        await admin(w, '/purge', { tags: ['glyph'] });
        view = { ...w, url: w.urls[1], urls: w.urls.slice(1) };
      }
      await w.plan(seeded);
      const res = await load(view, reqs, 8);
      let wrongBytes = 0, badPng = 0, slow = 0;
      for (let i = 0; i < res.results.length; i++) {
        const x = res.results[i];
        x.want = plan.allow.includes(x.status) ? x.status : plan.allow[0];
        if (x.ms > (plan.maxMs || 12_000)) slow++;
        if (x.status !== 200) continue;
        try { decodePng(x.body); } catch { badPng++; continue; }
        if (plan.exact && !same(x.body, await reference(reqs[i].text, reqs[i].size))) wrongBytes++;
      }
      const log = await w.chaosLog();
      const st = await admin(w, '/stats');
      const byRule = {}; for (const e of log) byRule[e.rule] = (byRule[e.rule] || 0) + 1;
      // Recovery: with the faults gone, every URL that failed must work again (nothing poisoned).
      let unrecovered = 0;
      if (plan.recover) {
        await w.plan({ seed: 7, rules: [] });
        for (let i = 0; i < reqs.length; i++) if (res.results[i].status !== 200) {
          const again = await fetch(`${w.url}${reqs[i].path}`, { headers: { connection: 'close' } });
          await again.arrayBuffer();
          if (again.status !== 200) unrecovered++;
        }
      }
      const row = await report(`chaos:${plan.name}`.slice(0, 20), 8, w, base, res, { plan: plan.name, injections: log.length, byRule, wrongBytes, badPng, slow, unrecovered, r2: st.r2, logKey: logKey(log) });
      console.log(`         injected ${JSON.stringify(byRule)}  wrong bytes ${wrongBytes}, bad PNG ${badPng}, over deadline ${slow}${plan.recover ? `, unrecovered after faults cleared ${unrecovered}` : ''}`);
      await w.stop();
      // Replay: the same seed over the same requests injects the same faults, at any interleaving.
      if (plan.replay) {
        const w2 = await boot(plan.app, port, port + 1, { chaos: true });
        await w2.plan(seeded);
        await load(w2, reqs, 3);
        const again = logKey(await w2.chaosLog());
        row.replayIdentical = again === row.logKey;
        console.log(`         replay at a different concurrency: injection log ${row.replayIdentical ? 'identical' : 'DIFFERENT'}`);
        await w2.stop();
      }
      delete row.logKey;
      rows.push(row);
    }
    return rows;
  },
  // Same pixels on both runtimes: the PNG from workerd equals the PNG rendered in Node.
  async parity(port) {
    const { loadFont, renderText, flattenCache } = await import('../index.js');
    const { pngJob } = await import('../cache/index.js');
    const font = (await loadFont(readFileSync(new URL('../third_party/fonts/inter-latin-400.woff2', import.meta.url)))).value;
    const w = await boot('cached', port, port + 1);
    let same = 0;
    const cases = ['Workers', 'Hello, edge', 'office waffle', 'AVTo 0123'];
    for (const t of cases) {
      const remote = new Uint8Array(await (await fetch(`${w.url}/?t=${encodeURIComponent(t)}`)).arrayBuffer());
      const r = await renderText([{ font, fontKey: 'inter', text: t, size: 96 }], { targets: [] });
      const local = (await pngJob(r.value.scene, { outlines: flattenCache() }).make()).value;
      const h = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
      if (h(remote) === h(local)) same++;
      console.log(`parity   ${t.padEnd(14)} workerd ${h(remote)}  node ${h(local)}  ${h(remote) === h(local) ? 'identical' : 'DIFFERENT'}`);
    }
    await w.stop();
    return [{ scenario: 'parity', identical: same, of: cases.length }];
  },
};

const pick = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const all = {};
let port = 18787;
for (const name of pick.length ? pick : Object.keys(SCENARIOS)) { all[name] = await SCENARIOS[name](port); port += 2; }
// ---- gate (--check) ---------------------------------------------------------------------------
// Invariants the simulator holds the app to. Memory: the live set after GC (heap + buffers)
// must stay small, or something is retained. Allocation churn per render is gated
// deterministically in render/test/alloc.test.js.
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail });
for (const [name, rows] of Object.entries(all)) for (const r of rows) {
  if ('unexpected' in r) expect(`${r.scenario} c=${r.concurrency}: every status as expected`, r.unexpected === 0, `${r.unexpected} unexpected, ${JSON.stringify(r.status)}`);
  // Peak includes garbage, and local V8 (no heap limit) collects later than production, which
  // runs under its 128 MB limit: reported, not gated. The live set is what the app holds.
  if ('isolatePeakMb' in r && r.isolatePeakMb > 96) console.log(`warn ${r.scenario} c=${r.concurrency}: isolate peak incl. garbage ${r.isolatePeakMb} MB (live ${r.isolateLiveMb} MB)`);
  if ('isolateLiveMb' in r) expect(`${r.scenario} c=${r.concurrency}: live set < 32 MB`, r.isolateLiveMb < 32, `${r.isolateLiveMb} MB`);
  if (r.scenario === 'parity') expect('parity: workerd PNG bytes = Node PNG bytes', r.identical === r.of, `${r.identical}/${r.of}`);
  if (r.scenario === 'spec') {
    expect('spec: every render 200 and byte-identical to Node, cold and warm', r.failures === 0 && r.rows.length > 0, `${r.failures} of ${r.rows.length} failed${r.skipped ? `; ${r.skipped} specs skipped (fonts not on disk)` : ''}`);
    expect('spec: concurrent cold burst all 200', Object.keys(r.burst).every((k) => k === '200'), JSON.stringify(r.burst));
  }
}
if (all.chaos) for (const r of all.chaos) {
  expect(`chaos ${r.plan}: no injected 200 serves wrong or broken bytes`, r.wrongBytes === 0 && r.badPng === 0, `wrong ${r.wrongBytes}, bad PNG ${r.badPng}`);
  expect(`chaos ${r.plan}: every response within its deadline`, r.slow === 0, `${r.slow} over`);
  expect(`chaos ${r.plan}: faults were injected`, r.injections > 0, `${r.injections}`);
  // Corruption on R2 reads only tests anything if reads returned data (the warm-up phase's job).
  if (r.plan === 'r2-corrupt') expect('chaos r2-corrupt: R2 reads returned data (corruption reached the integrity check)', r.r2.hits > 0, `${r.r2.hits} R2 hits`);
  if ('replayIdentical' in r) expect(`chaos ${r.plan}: replay from seed injects the same faults`, r.replayIdentical, '');
  if (r.unrecovered) expect(`chaos ${r.plan}: recovers once faults clear (nothing poisoned)`, false, `${r.unrecovered} still failing`);
  else if (r.plan === 'net-corrupt') expect(`chaos ${r.plan}: recovers once faults clear (nothing poisoned)`, true, '0 still failing');
}
if (all.colo) {
  const renders = all.colo.map((r) => r.r2.puts), hits = all.colo.map((r) => r.wc.hits);
  expect('colo: each distinct key rendered once, whatever the isolate count', new Set(renders).size === 1, `renders ${renders.join(', ')}`);
  expect('colo: Workers Cache hits grow with isolates', hits.every((h, i) => i === 0 || h > hits[i - 1]), `hits ${hits.join(', ')}`);
}
if (CHECK) {
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  (${c.detail})`);
  const bad = checks.filter((c) => !c.ok).length;
  console.log(bad ? `\n${bad} check(s) failed` : `\nall ${checks.length} checks passed`);
  if (bad) process.exitCode = 1;
}
const outFile = `${SIM}out/results.json`;
(await import('node:fs')).writeFileSync(outFile, JSON.stringify(all, (k, v) => (k === 'body' ? undefined : v), 1));
console.log(`\nresults → ${outFile.replace(SIM, 'sim/')}`);
