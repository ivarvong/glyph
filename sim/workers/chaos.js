// The chaos worker: sits, by config, between the app and the services it depends on, and
// applies a seeded fault plan (chaos/plan.js). The app's code is unchanged; its bindings point here.
//
//   main ─globalOutbound─▶ chaos (default fetch) ─▶ UPSTREAM  (the network: net, or the TCP proxy)
//   main ─env.R2─────────▶ chaos#R2              ─▶ R2T       (R2 model)
//   main ─ctx.exports────▶ chaos#Cache           ─▶ WCT       (Workers Cache model)
//   admin ───────────────▶ chaos#Admin           plan in, injection log out
//
// All entrypoints run in this one isolate, so they share the plan, the counters and the log.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { decide, recorder, flipPositions, identity } from 'plan.js';

let plan = { seed: 1, rules: [] };
const rec = recorder();
const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);

/** Decide, log, and apply the delay. @param {string} at @param {import('./plan.js').Call} call */
async function inject(at, call) {
  const n = rec.next(identity(at, call));
  const dn = decide(plan, at, call, n);
  rec.record(dn);
  await wait(dn.delayMs);
  return dn;
}

/** Flip bytes at seeded positions as the body streams through. */
function corrupting(body, d) {
  const at = flipPositions(plan.seed, d.terminal.rule, d.id, d.n, d.terminal.flips || 4);
  let off = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, c) {
      const b = new Uint8Array(chunk);
      for (const p of at) if (p >= off && p < off + b.length) b[p - off] ^= 0xff;
      off += b.length; c.enqueue(b);
    },
  }));
}
/** Re-chunk a body into small pieces with a pause between: a slow link, alive on timers. */
function dripping(body, { chunk = 256, intervalMs = 20 }) {
  return body.pipeThrough(new TransformStream({
    async transform(c, out) { const b = new Uint8Array(c); for (let o = 0; o < b.length; o += chunk) { out.enqueue(b.subarray(o, o + chunk)); await wait(intervalMs); } },
  }));
}
/** Headers and nothing else, held open on a real timer (a stream with nothing pending would be
 *  cancelled by workerd's hang detection, which a real stalled origin is not). */
function stalled() {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(); w.write(new Uint8Array(16)); setTimeout(() => w.close(), 120_000);
  return readable;
}

export default {
  // The network. Faults: error (fetch rejects), status, corrupt, drip, stall; delay composes.
  async fetch(req, env) {
    const u = new URL(req.url);
    const d = await inject('net', { method: req.method, host: u.host, path: u.pathname + u.search });
    const t = d.terminal;
    if (t && t.kind === 'error') throw new Error(`chaos: injected network error (${t.rule})`);
    if (t && t.kind === 'status') return new Response(`chaos: injected ${t.status}`, { status: t.status || 503 });
    if (t && t.kind === 'stall') return new Response(stalled(), { status: 200 });
    const res = await env.UPSTREAM.fetch(req);
    if (!t || !res.body) return res;
    if (t.kind === 'corrupt') return new Response(corrupting(res.body, d), res);
    if (t.kind === 'drip') return new Response(dripping(res.body, t), { status: res.status, headers: res.headers });
    return res;
  },
};

export class R2 extends WorkerEntrypoint {
  async get(key) {
    const d = await inject('r2', { method: 'get', key });
    const t = d.terminal;
    if (t && t.kind === 'error') throw new Error(`chaos: injected R2 get failure (${t.rule})`);
    if (t && t.kind === 'missing') return null;
    const v = await this.env.R2T.get(key);
    if (v && t && t.kind === 'corrupt') {
      const b = v.slice();
      for (const p of flipPositions(plan.seed, t.rule, d.id, d.n, t.flips || 4, b.length)) b[p] ^= 0xff;
      return b;
    }
    return v;
  }
  async put(key, bytes) {
    const d = await inject('r2', { method: 'put', key });
    const t = d.terminal;
    if (t && t.kind === 'error') throw new Error(`chaos: injected R2 put failure (${t.rule})`);
    if (t && t.kind === 'drop') return true; // acknowledged, never stored
    return this.env.R2T.put(key, bytes);
  }
  stats() { return this.env.R2T.stats(); }
}

export class Cache extends WorkerEntrypoint {
  // The Workers Cache hop. Faults: error (the hop rejects), status, corrupt; delay composes.
  async fetch(req) {
    const key = (req.cf && req.cf.cacheKey) || new URL(req.url).pathname;
    const d = await inject('wc', { method: req.method, key });
    const t = d.terminal;
    if (t && t.kind === 'error') throw new Error(`chaos: injected Workers Cache failure (${t.rule})`);
    if (t && t.kind === 'status') return new Response(`chaos: injected ${t.status}`, { status: t.status || 503 });
    const res = await this.env.WCT.fetch(req, { cf: req.cf });
    if (t && t.kind === 'corrupt' && res.body) return new Response(corrupting(res.body, d), res);
    return res;
  }
}

export class Admin extends WorkerEntrypoint {
  setPlan(p) { plan = p; rec.reset(); return true; }
  log() { return rec.log(); }
}
