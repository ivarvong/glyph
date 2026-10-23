// Socket-level faults. A Node HTTP proxy that workerd reaches as an `external` service, so the
// runtime's real HTTP client meets real socket behaviour: a refused or reset connection, a body
// shorter than its Content-Length, a dribbling link, a stall. It forwards to the fake internet
// (the `net` worker on its own workerd socket). One request per connection (`connection: close`)
// so a fault applies to exactly one request. Same plan format and decisions as the chaos worker.
import { createServer, request } from 'node:http';
import { decide, recorder } from './plan.js';

/** @param {{ upstreamPort: number }} o */
export async function tcpChaos({ upstreamPort }) {
  let plan = { seed: 1, rules: [] };
  const rec = recorder();
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const host = req.headers.host || '';
    const call = { method: req.method, host, path: req.url };
    const n = rec.next(`tcp ${call.method} ${host}${req.url}`);
    const d = decide(plan, 'tcp', call, n);
    rec.record(d);
    const t = d.terminal;
    if (t && t.kind === 'refuse') { req.socket.resetAndDestroy(); return; }
    if (d.delayMs > 0) await new Promise((r) => setTimeout(r, d.delayMs));
    const up = request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: { ...req.headers, connection: 'close' } }, (ur) => {
      const headers = { ...ur.headers, connection: 'close' };
      delete headers['transfer-encoding'];
      if (!headers['content-length']) delete headers['content-length']; // close-delimited body
      res.writeHead(ur.statusCode || 502, headers);
      res.flushHeaders();
      if (t && t.kind === 'stall') { ur.pause(); return; } // headers, then silence until the client gives up
      let sent = 0;
      const limit = t && (t.kind === 'reset' || t.kind === 'truncate') ? t.afterBytes || 0 : Infinity;
      const chunk = t && t.kind === 'drip' ? t.chunk || 256 : Infinity;
      const gap = t && t.kind === 'drip' ? t.intervalMs || 20 : 0;
      // Writes are serialised on one promise chain, so a drip's paced writes finish before end.
      let chain = Promise.resolve();
      const pace = (ms) => new Promise((r) => setTimeout(r, ms));
      ur.on('data', (buf) => {
        chain = chain.then(async () => {
          if (sent >= limit) return;
          const take = buf.subarray(0, Math.max(0, limit - sent));
          if (gap) { ur.pause(); for (let o = 0; o < take.length; o += chunk) { res.write(take.subarray(o, o + chunk)); await pace(gap); } ur.resume(); }
          else res.write(take);
          sent += take.length;
          if (sent >= limit) {
            ur.destroy();
            // reset: RST mid-body. truncate: a clean FIN, short of the declared Content-Length.
            if (t.kind === 'reset') res.socket.resetAndDestroy(); else res.socket.end();
          }
        });
      });
      ur.on('end', () => { chain = chain.then(() => { if (sent < limit) res.end(); }); });
      ur.on('error', () => res.socket && res.socket.destroy());
    });
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('tcp proxy: upstream error'); } else res.socket.destroy(); });
    req.pipe(up);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: /** @type {any} */ (server.address()).port,
    setPlan: (p) => { plan = p; rec.reset(); },
    log: () => rec.log(),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r(true)); }),
  };
}
