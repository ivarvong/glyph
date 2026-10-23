// Bundle an example worker, unchanged, into one ES module for workerd, plus the workerd config
// that wires it to the simulator's services:
//
//   client ──http──▶ main (example + entry shim) ──globalOutbound──▶ net   (fake internet)
//                     │  env.R2 ─────RPC──▶ r2      (R2 model)
//                     │  env.WCACHE ─────▶ wcache  (Workers Cache model) ──▶ main#Renders
//                     admin ──RPC──▶ r2 / wcache / net   (stats, purge, fault injection)
//
// With `chaos`, the app's dependencies go through the chaos worker (workers/chaos.js), and the
// network optionally through the TCP fault proxy (chaos/tcp.js) as an `external` service:
//
//   main ─outbound─▶ chaos ─▶ tcpnet (external: Node proxy) ─▶ netsock ─▶ net
//   main ─R2───────▶ chaos#R2 ─▶ r2        main ─WCACHE─▶ chaos#Cache ─▶ wcache ─▶ main#Renders
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { FIXTURE_FONTS } from '../examples/specs/fonts.js';

const ROOT = new URL('../', import.meta.url).pathname;
const SIM = new URL('./', import.meta.url).pathname;

export const APPS = {
  cached: { src: 'examples/worker-cached.ts', renders: true },
  fetch: { src: 'examples/worker-fetch.ts', renders: false },
  // The generic spec renderer. Its fake internet serves every spec in examples/specs and
  // out/specs at https://specs.example.com/<file>, and every font those specs name at its URL.
  render: { src: 'worker/src/index.js', renders: true, files: true },
};

/**
 * Files the fake internet serves, by host + path: specs, and the fonts they reference (read from
 * the local google/fonts checkout for pinned raw.githubusercontent URLs).
 * @returns {{ route: string, file: string }[]}
 */
/** Font URLs served from third_party/fonts/ (same bytes as the URL, pinned by SHA-256 in the specs). */
export { FIXTURE_FONTS };

function servedFiles() {
  const MIRROR = /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[0-9a-f]{40}\/(.*)$/;
  const out = [], seen = new Set();
  for (const dir of [`${ROOT}examples/specs/`, `${ROOT}out/specs/`]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      out.push({ route: `specs.example.com/${f}`, file: `${dir}${f}` });
      const spec = JSON.parse(readFileSync(`${dir}${f}`, 'utf8'));
      for (const ref of Object.values(spec.fonts || {})) {
        const url = typeof ref === 'string' ? ref : ref.url, m = MIRROR.exec(url);
        const file = url in FIXTURE_FONTS ? `${ROOT}${FIXTURE_FONTS[url]}` : m ? `${ROOT}conform/.ext/gfonts/${m[1].split('/').map(decodeURIComponent).join('/')}` : '';
        // A font not on disk (no conform/.ext/gfonts checkout) is not served: its specs are skipped.
        if (!file || seen.has(url) || !existsSync(file)) continue;
        seen.add(url);
        const u = new URL(url);
        out.push({ route: `${u.host}${u.pathname}`, file });
      }
    }
  }
  return out;
}

/** @param {keyof typeof APPS} name @param {{ port: number, adminPort: number, compatibilityDate?: string, v8Flags?: string[], isolates?: number, chaos?: { tcpPort?: number, netPort?: number } | null }} o */
export async function buildApp(name, { port, adminPort, compatibilityDate = '2026-09-01', v8Flags = [], isolates = 1, chaos = null }) {
  const app = APPS[name];
  const out = `${SIM}out/${name}/`;
  mkdirSync(out, { recursive: true });
  // Entry: the shim, plus a Renders subclass when the example has one (its env needs the R2 shape).
  const entry = `${out}entry.js`;
  writeFileSync(entry, `export { default } from '${SIM}workers/entry.js';\n` + (app.renders
    ? `import * as app from 'app.js';\nconst r2Shape = (rpc) => ({ async get(k) { const b = await rpc.get(k); return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null; }, async put(k, v) { await rpc.put(k, new Uint8Array(v)); } });\nexport class Renders extends app.Renders { constructor(ctx, env) { super(ctx, { ...env, RENDERS: r2Shape(env.R2) }); } }\n`
    : ''));
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}worker.js`,
    external: ['cloudflare:workers', 'node:*'], logLevel: 'error',
    alias: { 'app.js': `${ROOT}${app.src}`, glyph: `${ROOT}index.js`, 'glyph/cache': `${ROOT}cache/index.js` },
    loader: { '.woff2': 'binary' },
    plugins: [{ name: 'fixture-font', setup(b) { b.onResolve({ filter: /^\.\/inter-latin-400\.woff2$/ }, () => ({ path: `${ROOT}third_party/fonts/inter-latin-400.woff2` })); } }],
  });
  for (const w of ['r2.js', 'wcache.js', 'net.js', 'admin.js', 'chaos.js']) copyFileSync(`${SIM}workers/${w}`, `${out}${w}`);
  copyFileSync(`${SIM}chaos/plan.js`, `${out}plan.js`);
  copyFileSync(`${ROOT}third_party/fonts/inter-latin-400.woff2`, `${out}inter.woff2`);
  copyFileSync(`${ROOT}third_party/fonts/source-serif-4-regular.otf.woff2`, `${out}serif.woff2`);
  copyFileSync(`${ROOT}third_party/fuzz/slow-tiny-upem-35d6d4188c01.bin`, `${out}hostile.bin`);
  // Served files: one data module each, and a routing table for the net worker.
  const files = app.files ? servedFiles() : [];
  files.forEach((f, i) => copyFileSync(f.file, `${out}file${i}.bin`));
  writeFileSync(`${out}files.js`, files.map((_, i) => `import f${i} from 'file${i}.bin';`).join('\n') +
    `\nexport default {${files.map((f, i) => `${JSON.stringify(f.route)}: f${i}`).join(', ')}};\n`);
  const svc = (s) => `(name = "${s.name}", worker = (modules = [${s.modules}], compatibilityDate = "${compatibilityDate}"${s.bindings ? `, bindings = [${s.bindings}]` : ''}${s.outbound ? `, globalOutbound = "${s.outbound}"` : ''}))`;
  const mod = (n, kind = 'esModule') => `(name = "${n}", ${kind} = embed "${n}")`;
  // One service per isolate ('main', 'main1', …), all sharing R2, Workers Cache and the network:
  // the colo model. The Workers Cache origin (the Renders entrypoint) lives on 'main'.
  const mains = Array.from({ length: isolates }, (_, i) => (i ? `main${i}` : 'main'));
  const via = chaos ? 'chaos' : null;
  const r2For = via ? '(name = "chaos", entrypoint = "R2")' : '(name = "r2", entrypoint = "R2")';
  const wcFor = via ? '(name = "chaos", entrypoint = "Cache")' : '(name = "wcache", entrypoint = "Cache")';
  const services = [
    ...mains.map((n) => svc({ name: n, modules: mod('worker.js'), outbound: via || 'net',
      bindings: `(name = "R2", service = ${r2For})${app.renders ? `, (name = "WCACHE", service = ${wcFor})` : ''}` })),
    ...(chaos ? [
      svc({ name: 'chaos', modules: [mod('chaos.js'), mod('plan.js')].join(', '),
        bindings: `(name = "UPSTREAM", service = "${chaos.tcpPort ? 'tcpnet' : 'net'}"), (name = "R2T", service = (name = "r2", entrypoint = "R2")), (name = "WCT", service = (name = "wcache", entrypoint = "Cache"))` }),
      ...(chaos.tcpPort ? [`(name = "tcpnet", external = (address = "127.0.0.1:${chaos.tcpPort}", http = ()))`] : []),
    ] : []),
    svc({ name: 'r2', modules: mod('r2.js') }),
    svc({ name: 'wcache', modules: mod('wcache.js'), bindings: app.renders ? '(name = "ORIGIN", service = (name = "main", entrypoint = "Renders"))' : '' }),
    svc({ name: 'net', modules: [mod('net.js'), mod('files.js'), mod('inter.woff2', 'data'), mod('serif.woff2', 'data'), mod('hostile.bin', 'data'), ...files.map((_, i) => mod(`file${i}.bin`, 'data'))].join(', ') }),
    svc({ name: 'admin', modules: mod('admin.js'), bindings: '(name = "R2", service = (name = "r2", entrypoint = "R2")), (name = "WC", service = (name = "wcache", entrypoint = "Cache")), (name = "NET", service = (name = "net", entrypoint = "Admin"))' + (chaos ? ', (name = "CHAOS", service = (name = "chaos", entrypoint = "Admin"))' : '') }),
  ];
  writeFileSync(`${out}config.capnp`, `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  v8Flags = [${v8Flags.map((f) => JSON.stringify(f)).join(', ')}],
  services = [
    ${services.join(',\n    ')}
  ],
  sockets = [
    ${mains.map((n, i) => `(name = "http${i}", address = "127.0.0.1:${port + 100 * i}", http = (), service = "${n}"),`).join('\n    ')}
    (name = "admin", address = "127.0.0.1:${adminPort}", http = (), service = "admin"),${chaos && chaos.netPort ? `\n    (name = "netsock", address = "127.0.0.1:${chaos.netPort}", http = (), service = "net"),` : ''}
  ],
);
`);
  return { dir: out, config: `${out}config.capnp`, mains, ports: mains.map((_, i) => port + 100 * i) };
}
