// @ts-check
// Fonts from URLs, safely. The font bytes are untrusted (the parser is fuzzed for that); this
// module bounds everything around them: which URLs may be fetched, how long it may take, how
// many bytes may arrive, and how many redirects may be followed. Errors are values throughout.
//
//   const r = await fetchFont('https://fonts.example/Inter.woff2', { fonts: memo(Policy.Lru, …) });
//   if (r.tag === 'Ok') r.value.font …  else r.error  // FontFetchError.Fetch(FetchError) | .Load(…)
//
// Policy (default `publicHttps`): https only, no credentials in the URL, a DNS name (no IP
// literals, no localhost / .local / .internal), the default port. Every redirect hop is checked
// again. Narrow it to an allowlist with `allowHosts([...])`. This blocks the obvious SSRF routes
// by URL; it cannot see what a name resolves to. On Workers, fetch() cannot reach private networks
// anyway; on a server, put the fetcher behind an egress proxy if names you allow could be rebound.
//
// One deadline covers the whole fetch: every hop and the body. The size cap is checked against
// Content-Length before reading and against the bytes actually received while reading (a missing
// or lying header cannot get past it).
import { variants, ok, err, some, NONE } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { LIMITS } from '../../sfnt/src/limits.js';
import { loadFont as loadWith } from '../../sfnt/src/font.js';
import { autoBrotli } from '../../woff2/src/brotli.js';
import { sha256, hex } from '../../cache/src/key.js';

export const FetchError = variants('FetchError', {
  BadUrl: ['input'],
  Disallowed: ['url', 'why'],
  Network: ['url', 'message'],
  Status: ['url', 'status'],
  TooLarge: ['url', 'limit', 'seen'],
  Timeout: ['url', 'ms'],
  TooManyRedirects: ['url', 'limit'],
});
export const FontFetchError = variants('FontFetchError', { Fetch: ['error'], Load: ['error'] });

/** A URL policy: '' to allow, else the reason it is refused. @typedef {(url: URL) => string} UrlPolicy */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** https, a public-looking DNS name, the default port, no userinfo. @type {UrlPolicy} */
export const publicHttps = (u) => {
  if (u.protocol !== 'https:') return `scheme ${u.protocol} (https only)`;
  if (u.username || u.password) return 'credentials in URL';
  if (u.port !== '') return `port ${u.port}`;
  const h = u.hostname;
  if (h.startsWith('[') || IPV4.test(h) || /^\d+$/.test(h) || /^0x/i.test(h)) return `IP literal host ${h}`;
  if (!h.includes('.') || LOCAL_SUFFIX.test(h)) return `local host name ${h}`;
  return '';
};

/**
 * Only these hosts (exact, or `*.example.com` for subdomains), on top of `base`.
 * @param {string[]} hosts @param {UrlPolicy} [base]
 * @returns {UrlPolicy}
 */
export const allowHosts = (hosts, base = publicHttps) => {
  const exact = new Set(hosts.filter((h) => !h.startsWith('*.')).map((h) => h.toLowerCase()));
  const wild = hosts.filter((h) => h.startsWith('*.')).map((h) => h.slice(1).toLowerCase());
  return (u) => {
    const why = base(u);
    if (why) return why;
    const h = u.hostname.toLowerCase();
    return exact.has(h) || wild.some((w) => h.endsWith(w)) ? '' : `host ${h} not in allowlist`;
  };
};

/** @param {string} input @returns {import('../../otel-compact/src/adt.js').Option<URL>} */
const parseUrl = (input) => {
  try { return some(new URL(input)); } catch { return NONE; } // platform edge: URL parsing throws
};

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * @typedef {object} FetchOpts
 * @property {(input: string, init: RequestInit) => Promise<Response>} [fetch]  default globalThis.fetch
 * @property {UrlPolicy} [policy]       default publicHttps
 * @property {number} [maxBytes]        default LIMITS.fileBytes (16 MiB)
 * @property {number} [timeoutMs]       one deadline for all hops and the body; default 10 s
 * @property {number} [maxRedirects]    default 3
 * @property {import('../../otel-compact/src/trace.js').Span} [span]
 */

/**
 * GET `input` within the policy, deadline and byte cap. Never throws.
 * @param {string} input @param {FetchOpts} [opts]
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<{ url: string, bytes: Uint8Array }, any>>}
 */
export async function fetchBytes(input, {
  fetch = (i, init) => globalThis.fetch(i, init), policy = publicHttps, maxBytes = LIMITS.fileBytes,
  timeoutMs = 10_000, maxRedirects = 3, span = NOOP_SPAN,
} = {}) {
  return span.span('net.fetch', async (s) => {
    const first = parseUrl(input);
    if (first.tag === 'None') return err(FetchError.BadUrl(String(input)));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let url = first.value;
      for (let hop = 0; ; hop++) {
        const why = policy(url);
        if (why) return err(FetchError.Disallowed(url.href, why));
        if (hop > maxRedirects) return err(FetchError.TooManyRedirects(url.href, maxRedirects));
        const res = await settle(fetch(url.href, { redirect: 'manual', signal: ctl.signal }));
        if (res.tag === 'Err') return err(ctl.signal.aborted ? FetchError.Timeout(url.href, timeoutMs) : FetchError.Network(url.href, res.error));
        const r = res.value;
        if (REDIRECT.has(r.status)) {
          const loc = r.headers.get('location') || '';
          cancel(r);
          const next = parseUrl(loc ? resolve(loc, url) : '');
          if (next.tag === 'None') return err(FetchError.BadUrl(loc));
          url = next.value;
          continue;
        }
        if (!r.ok) { cancel(r); return err(FetchError.Status(url.href, r.status)); }
        const declared = Number(r.headers.get('content-length') || NaN);
        if (declared > maxBytes) { cancel(r); return err(FetchError.TooLarge(url.href, maxBytes, declared)); }
        const body = await readCapped(r, maxBytes);
        if (body.tag === 'Err') {
          if (body.error === 'too large') return err(FetchError.TooLarge(url.href, maxBytes, maxBytes + 1));
          return err(ctl.signal.aborted ? FetchError.Timeout(url.href, timeoutMs) : FetchError.Network(url.href, body.error));
        }
        if (s.recording) { s.set('bytes', body.value.length); s.set('redirects', hop); }
        return ok({ url: url.href, bytes: body.value });
      }
    } finally {
      clearTimeout(timer);
    }
  });
}

/** A Location header against the current URL; '' if it cannot be resolved. @param {string} loc @param {URL} base */
const resolve = (loc, base) => { try { return new URL(loc, base).href; } catch { return ''; } }; // platform edge: URL parsing throws

/**
 * A promise as a Result: the single place a platform rejection becomes a value.
 * @template T @param {Promise<T>} p
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<T, string>>}
 */
const settle = (p) => p.then((v) => ok(v), (e) => err(e instanceof Error ? e.message : String(e)));

/** Drop a body we will not read (frees the connection). @param {Response} r */
const cancel = (r) => { if (r.body) r.body.cancel().catch(() => {}); };

/**
 * Read a body up to `max` bytes; past it, stop reading and cancel.
 * @param {Response} r @param {number} max
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>}
 */
async function readCapped(r, max) {
  if (!r.body) return ok(new Uint8Array(0));
  const reader = r.body.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  for (;;) {
    const step = await settle(reader.read());
    if (step.tag === 'Err') return step;
    if (step.value.done) break;
    const chunk = step.value.value;
    n += chunk.length;
    if (n > max) { reader.cancel().catch(() => {}); return err('too large'); }
    parts.push(chunk);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return ok(out);
}

/**
 * @typedef {object} FontFetchOpts
 * @property {import('../../cache/src/policy.js').Memo<{ font: import('../../sfnt/src/font.js').Font, bytes: Uint8Array }>} [fonts]
 *   parsed fonts by content (SHA-256 of the bytes): two URLs serving one file parse once.
 *   Entries are sized by fontCost(bytes): a measured upper bound on a parsed font's heap.
 * @property {import('../../cache/src/layers.js').Loader} [via]
 *   a cache stack for the bytes (e.g. memory → R2), keyed by URL; its `make` is the capped fetch
 * @property {Partial<import('../../sfnt/src/containers.js').Ports>} [ports]
 * @property {(p: Promise<unknown>) => void} [defer]  background hook for cache writes (Workers: ctx.waitUntil)
 */

/**
 * URL → bytes (policy, deadline, cap; optionally through a cache stack) → Font (memoised by content).
 * @param {string} url @param {FetchOpts & FontFetchOpts} [opts]
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<{ font: import('../../sfnt/src/font.js').Font, key: string, url: string, bytes: Uint8Array }, any>>}
 */
export async function fetchFont(url, opts = {}) {
  const { fonts, via, ports = {}, span = NOOP_SPAN } = opts;
  /** @param {Uint8Array} b */
  const parse = (b) => loadWith(b, { brotli: autoBrotli, span, ...ports });
  // Through a cache stack the bytes are parsed before they are cached: bytes that do not load
  // (corrupted in transit, a bad upload) must not be stored under the URL, or the URL stays
  // broken after the origin recovers (chaos: net-corrupt). The parse is kept, not repeated.
  /** @type {Map<Uint8Array, import('../../sfnt/src/font.js').Font>} */
  const parsedNow = new Map();
  const got = via
    ? await via(fontJob(url, { ...opts, validate: async (b) => { const f = await parse(b); if (f.tag === 'Ok') parsedNow.set(b, f.value); return f; } }))
    : await fetchBytes(url, opts).then((r) => (r.tag === 'Ok' ? ok(r.value.bytes) : r));
  if (got.tag === 'Err') {
    const e = got.error;
    return err(typeof e === 'string' && e.startsWith(LOAD_PREFIX) ? FontFetchError.Load(JSON.parse(e.slice(LOAD_PREFIX.length))) : FontFetchError.Fetch(e));
  }
  const bytes = got.value;
  const fresh = parsedNow.get(bytes);
  const key = hex(sha256(bytes));
  if (fonts) {
    const hit = fonts.get(key);
    if (hit.tag === 'Some') return ok({ font: hit.value.font, key, url, bytes });
  }
  const f = fresh ? ok(fresh) : await parse(bytes);
  if (f.tag === 'Err') return err(FontFetchError.Load(f.error));
  if (fonts) fonts.set(key, { font: f.value, bytes }, fontCost(bytes.length));
  return ok({ font: f.value, key, url, bytes });
}

/**
 * Heap a parsed font holds, as a function of its file size: an upper bound from measurement.
 * Ten sample fonts (14–446 KiB) parsed to 0.7–6.6× their size, and to 3.3–16× after shaping
 * warmed their glyph and layout caches; small fonts carry a fixed ~150–250 KiB. 10× + 256 KiB
 * bounds every one. (The previous guess, 4×, under-counted typical static fonts by up to 4×.)
 * @param {number} bytes
 */
export const fontCost = (bytes) => bytes * 10 + (256 << 10);

/** Loader errors are text; a parse failure inside a job is marked so fetchFont can type it. */
const LOAD_PREFIX = 'font does not load: ';

/**
 * A cache Job for a font's bytes by URL, for any stack from cache/src/layers.js.
 * A failed fetch is an Err (never cached), described as text. With `validate`, bytes that
 * fail it are an Err too, so only usable fonts are ever cached.
 * @param {string} url
 * @param {FetchOpts & { defer?: (p: Promise<unknown>) => void, validate?: (b: Uint8Array) => Promise<import('../../otel-compact/src/adt.js').Result<unknown, any>> }} [opts]
 * @returns {import('../../cache/src/layers.js').Job}
 */
export const fontJob = (url, opts = {}) => {
  /** @type {import('../../cache/src/layers.js').Job} */
  const job = {
    key: `font-url:${hex(sha256(new TextEncoder().encode(url)))}`,
    meta: { url },
    make: async () => {
      const r = await fetchBytes(url, opts);
      if (r.tag === 'Err') return err(describe(r.error));
      if (opts.validate) { const v = await opts.validate(r.value.bytes); if (v.tag === 'Err') return err(LOAD_PREFIX + JSON.stringify(v.error)); }
      return ok(r.value.bytes);
    },
  };
  if (opts.defer) job.defer = opts.defer;
  return job;
};

/** One line for a FetchError. @param {any} e @returns {string} */
export const describe = (e) => FetchError.match(e, {
  BadUrl: ({ input }) => `bad URL ${JSON.stringify(input)}`,
  Disallowed: ({ url, why }) => `refused ${url}: ${why}`,
  Network: ({ url, message }) => `network error for ${url}: ${message}`,
  Status: ({ url, status }) => `${url} answered ${status}`,
  TooLarge: ({ url, limit }) => `${url} is over ${limit} bytes`,
  Timeout: ({ url, ms }) => `${url} took over ${ms} ms`,
  TooManyRedirects: ({ url, limit }) => `${url}: over ${limit} redirects`,
});
