// Dev-only (needs Playwright + Chromium): node verify/progressive.js
// Does Chromium paint a streamed PNG before it has all of it? The server holds the response at a
// gate: it delivers the first k chunks of the real pngStream output, then waits while we screenshot.
// A buffered response, by definition, has delivered nothing at that point.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
process.env.ONLY = 'none'; process.env.DPR = '1';
const G = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { SCENES } = await import(`${G}/examples/posters.js`);
const { scanline, flattenCache } = await import(`${G}/render/src/raster.js`);
const { fastZlib, balancedZlib } = await import(`${G}/render/src/png.js`);
const { pngChunks } = await import(`${G}/render/src/stream.js`);
const require = createRequire(process.env.PLAYWRIGHT_MODULES ?? '/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const scene = SCENES.code(), cache = flattenCache();
const collect = async (z, opts) => { const c = []; for await (const x of pngChunks(scene, scanline, z, { cache, ...opts })) c.push(x); return c; };
for (const [name, z] of [['fast', fastZlib], ['balanced', balancedZlib]]) {
  const c = await collect(z, { rows: 16, idat: 1 });
  console.log(`${name.padEnd(9)} rows=16 idat=1: ${c.length} chunks (${c.length - 3} IDATs)`);
}
const chunks = await collect(fastZlib, { rows: 16, idat: 1 });
let release = () => {}, gateAt = 0;
const srv = createServer(async (req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<body style="margin:0;background:#333"><img src="/img" width=${scene.width} height=${scene.height}></body>`); return; }
  res.writeHead(200, { 'content-type': 'image/png' });
  for (let i = 0; i < chunks.length; i++) {
    if (i === gateAt) await new Promise((r) => { release = r; });
    res.write(chunks[i]);
  }
  res.end();
}).listen(0);
const out = new URL('../out/progressive', import.meta.url).pathname; mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const frac of [0.25, 0.5, 0.75]) {
  gateAt = Math.round(chunks.length * frac);
  const page = await browser.newPage({ viewport: { width: scene.width, height: scene.height } });
  page.goto(`http://localhost:${srv.address().port}/`).catch(() => {});
  await page.waitForTimeout(700); // let Chromium decode what it has
  const bytes = chunks.slice(0, gateAt).reduce((n, c) => n + c.length, 0);
  const shot = `${out}/gate-${Math.round(frac * 100)}.png`;
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(shot, Buffer.from(data, 'base64'));
  console.log(`paused after ${gateAt}/${chunks.length} chunks (${bytes} of ${chunks.reduce((n, c) => n + c.length, 0)} bytes): ${shot}`);
  release(); await page.close();
}
await browser.close(); srv.close();
