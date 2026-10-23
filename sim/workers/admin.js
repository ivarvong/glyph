// The driver's control plane (a separate socket): stats from every service, purge by tag,
// fault injection. Not part of the app.
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const body = req.method === 'POST' ? await req.json() : {};
    if (u.pathname === '/stats') return Response.json({ r2: await env.R2.stats(), wc: await env.WC.stats(), net: await env.NET.stats() });
    if (u.pathname === '/purge') return Response.json({ purged: await env.WC.purge(body.tags || []) });
    if (u.pathname === '/faults') return Response.json({ net: await env.NET.configure(body.net || {}), r2: await env.R2.configure(body.r2 || {}) });
    if (u.pathname === '/chaos/plan' && env.CHAOS) return Response.json({ ok: await env.CHAOS.setPlan(body) });
    if (u.pathname === '/chaos/log' && env.CHAOS) return Response.json(await env.CHAOS.log());
    return new Response('not found', { status: 404 });
  },
};
