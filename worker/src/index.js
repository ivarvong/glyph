// The Worker: a generic renderer of scene specs (worker/src/app.js). No fonts, scenes or
// configuration are bundled; bindings are optional:
//   RENDERS   an R2 bucket: rendered images, content-addressed (else skipped)
//   SPECS     an R2 bucket: stored specs, POST /specs and ?id= (else those answer 501)
// and the `Renders` entrypoint can be cache-enabled (Workers Cache) in wrangler config:
//   "exports": { "default": { "type": "worker" }, "Renders": { "type": "worker", "cache": { "enabled": true } } }
// Limits can be tuned with GLYPH_* vars (see DEFAULTS), none required; GLYPH_TRACE=jsonl traces.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createRenderer, DEFAULTS } from './app.js';
import { tracer, Config, NOOP_TRACER, batchSink } from '../../otel-compact/src/trace.js';

// GLYPH_TRACE=jsonl: every request's span tree as compact JSONL on the console (Workers Logs /
// wrangler tail), summarised with otel-compact's otc. Off by default.
let traces = null;
const tracerFor = (env) => (traces ||= env && env.GLYPH_TRACE === 'jsonl'
  ? tracer(Config.Record(batchSink((chunk) => console.log(chunk.trimEnd()), { maxLines: 256 }), { resource: { service: 'glyph-render' } }))
  : NOOP_TRACER);

let renderer = null;
// GLYPH_STORE_BYTES (or GLYPH_storeBytes) overrides DEFAULTS.storeBytes, and so on.
const varOf = (env, k) => [`GLYPH_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`, `GLYPH_${k}`]
  .map((n) => (env && typeof env[n] === 'string' ? env[n] : '')).find((v) => v !== '' && Number.isFinite(Number(v))) || '';
const limitsFrom = (env) => Object.fromEntries(Object.keys(DEFAULTS)
  .filter((k) => varOf(env, k) !== '')
  .map((k) => [k, Number(varOf(env, k))]));
const get = (env) => (renderer ||= createRenderer(limitsFrom(env)));
const platform = (env, ctx, cached) => ({
  fetch: (input, init) => fetch(input, init),
  cached,
  bucket: env && env.RENDERS ? env.RENDERS : null,
  specs: env && env.SPECS ? env.SPECS : null,
  defer: (p) => ctx.waitUntil(p),
  tracer: tracerFor(env),
});

export class Renders extends WorkerEntrypoint {
  fetch(req) { return get(this.env).handleCached(req, platform(this.env, this.ctx, null)); }
}

export default {
  fetch(req, env, ctx) {
    const exp = ctx && ctx.exports && ctx.exports.Renders ? ctx.exports.Renders : null;
    return get(env).handle(req, platform(env, ctx, exp));
  },
};
