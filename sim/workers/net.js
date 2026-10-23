// The fake internet: this worker is the main worker's globalOutbound, so every fetch() the app
// makes lands here. Routes serve fixture fonts (embedded as data modules by the config), junk,
// redirects, a hostile-metrics font, and pathological servers. Faults are configurable over RPC:
// added latency, error rate, and stalls, to exercise the app's deadlines and error paths.
import { WorkerEntrypoint } from 'cloudflare:workers';
import inter from 'inter.woff2';
import serif from 'serif.woff2';
import hostile from 'hostile.bin';
import files from 'files.js'; // host + path → bytes (specs and fonts, for the render app)
const faults = { latencyMs: 0, errorRate: 0, stallRate: 0 };
const stats = { requests: 0, bytes: 0, byHost: {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const routes = {
  'fonts.gstatic.com/inter.woff2': () => new Response(inter),
  'fonts.gstatic.com/serif.woff2': () => new Response(serif),
  'cdn.jsdelivr.net/serif.woff2': () => new Response(null, { status: 302, headers: { location: 'https://fonts.gstatic.com/serif.woff2' } }),
  'fonts.gstatic.com/junk.woff2': () => new Response(new Uint8Array(4096).fill(0x42)),
  'fonts.gstatic.com/hostile.woff2': () => new Response(hostile),
  'fonts.gstatic.com/huge.woff2': () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1 << 16)); } })),
  // A real stalled origin is an I/O wait. A stream with nothing pending is not: workerd's hang
  // detector cancels it within milliseconds (found by this simulator). So the stall holds a timer.
  'fonts.gstatic.com/stall.woff2': () => { const { readable, writable } = new TransformStream(); const w = writable.getWriter(); w.write(new Uint8Array(100)); setTimeout(() => w.close(), 60_000); return new Response(readable); },
};
export class Admin extends WorkerEntrypoint {
  configure(f) { Object.assign(faults, f); return { ...faults }; }
  stats() { return JSON.parse(JSON.stringify(stats)); }
}
export default {
  async fetch(req) {
    const u = new URL(req.url);
    const k = u.host + u.pathname;
    stats.requests++; stats.byHost[u.host] = (stats.byHost[u.host] || 0) + 1;
    if (faults.latencyMs) await wait(faults.latencyMs);
    if (Math.random() < faults.errorRate) return new Response('upstream error', { status: 503 });
    if (Math.random() < faults.stallRate) return routes['fonts.gstatic.com/stall.woff2']();
    if (Object.prototype.hasOwnProperty.call(files, k)) return new Response(files[k], { headers: { 'content-length': String(files[k].byteLength) } });
    const r = routes[k];
    if (!r) return new Response('not found', { status: 404 });
    const res = r();
    const len = Number(res.headers.get('content-length') || 0); stats.bytes += len;
    return res;
  },
};
