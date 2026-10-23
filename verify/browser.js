// node verify/browser.js
// Runs the identical pipeline in Node and in Chromium, and compares SHA-256 of
// every output byte-for-byte. Dev-only: a static file server + headless_shell.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pipeline } from './pipeline.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.js': 'text/javascript', '.html': 'text/html', '.woff2': 'font/woff2', '.woff': 'font/woff', '.otf': 'font/otf' };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root)) throw new Error('outside root');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    res.end(await readFile(p));
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const nodeOut = await pipeline((p) => readFile(join(root, p)).then((b) => new Uint8Array(b)));
const nodeHashes = Object.fromEntries(Object.entries(nodeOut).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')]));

const base = '/opt/pw-browsers';
const shellDir = (await readdir(base)).find((d) => d.startsWith('chromium_headless_shell'));
const chromeDir = (await readdir(join(base, shellDir))).find((d) => d.startsWith('chrome-'));
const shell = process.env.HEADLESS_SHELL ?? join(base, shellDir, chromeDir, 'headless_shell');
// Async on purpose: a sync spawn would block this process's own file server.
const { stdout: dom } = await promisify(execFile)(shell, ['--no-sandbox', '--disable-gpu', '--virtual-time-budget=20000', '--dump-dom',
  `http://127.0.0.1:${port}/verify/browser.html`], { encoding: 'utf8', maxBuffer: 1 << 24 });
server.close();

const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!m) throw new Error(`no output from browser:\n${dom.slice(0, 2000)}`);
const browser = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
if (browser.error) throw new Error(`browser: ${browser.error}`);

let same = 0;
for (const [k, h] of Object.entries(nodeHashes)) {
  const ok = browser.hashes[k] === h;
  same += ok ? 1 : 0;
  console.log(`${ok ? 'same' : 'DIFF'}  ${k.padEnd(40)} ${h.slice(0, 16)}  ${browser.hashes[k]?.slice(0, 16)}`);
}
console.log(`\n${same}/${Object.keys(nodeHashes).length} outputs byte-identical in Node ${process.version} and ${browser.ua}`);
process.exit(same === Object.keys(nodeHashes).length ? 0 : 1);
