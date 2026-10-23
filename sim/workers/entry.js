// Adapts an example worker (bundled unchanged as app.js) to the simulator's services:
//   env.R2       → the R2-shaped bindings the examples use (RENDERS, FONTS)
//   env.WCACHE   → ctx.exports.Renders, so caller → Workers Cache model → Renders entrypoint
// Everything else is the example's own code, running in real workerd.
import * as app from "app.js";
const r2Shape = (rpc) => ({
  async get(key) { const b = await rpc.get(key); return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null; },
  async put(key, value) { await rpc.put(key, new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer ? value : await new Response(value).arrayBuffer())); },
});
const envOf = (env) => ({ ...env, RENDERS: r2Shape(env.R2), FONTS: r2Shape(env.R2) });
export default {
  fetch(req, env, ctx) {
    // Simulator-only: collect garbage inside a request, so the driver can read the live set
    // over the inspector (workerd's inspector has no collectGarbage and no idle context).
    if (new URL(req.url).pathname === '/__sim/gc') {
      const has = typeof globalThis.gc === 'function';
      if (has) globalThis.gc();
      return new Response(has ? 'collected' : 'start workerd with v8Flags --expose-gc', { status: has ? 200 : 501 });
    }
    const exports = { ...(ctx.exports || {}) };
    if (env.WCACHE) exports.Renders = env.WCACHE;
    const c = { waitUntil: (p) => ctx.waitUntil(p), passThroughOnException: () => ctx.passThroughOnException(), exports };
    return app.default.fetch(req, envOf(env), c);
  },
};
