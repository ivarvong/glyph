// R2 stand-in: a WorkerEntrypoint with get/put over RPC, held in this isolate's memory (one
// bucket per simulator run). entry.js adapts it to the R2 binding shape the examples use.
// Counts operations and can inject failures (Class A/B ops failing is a real R2 mode).
import { WorkerEntrypoint } from 'cloudflare:workers';
const objects = new Map();
const stats = { gets: 0, hits: 0, puts: 0, bytes: 0, failed: 0 };
let failRate = 0, latencyMs = 0;
const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);
export class R2 extends WorkerEntrypoint {
  async get(key) {
    stats.gets++; await wait(latencyMs);
    if (Math.random() < failRate) { stats.failed++; throw new Error('R2: simulated failure'); }
    const v = objects.get(key);
    if (v) stats.hits++;
    return v ?? null;
  }
  async put(key, bytes) {
    stats.puts++; await wait(latencyMs);
    if (Math.random() < failRate) { stats.failed++; throw new Error('R2: simulated failure'); }
    objects.set(key, bytes); stats.bytes += bytes.length;
    return true;
  }
  stats() { return { ...stats, objects: objects.size }; }
  configure(c) { failRate = c.failRate ?? failRate; latencyMs = c.latencyMs ?? latencyMs; return true; }
}
export default { fetch: () => new Response('r2 sim') };
