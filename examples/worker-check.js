// Run examples/worker.ts as a Worker would: same source, the .woff2 import swapped for
// the fixture bytes, `satisfies` stripped by Node's type stripping. Decodes the response.
//   node --experimental-strip-types examples/worker-check.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { decodePng } from '../verify/pngdecode.js';

const src = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8')
  .replace(/^import inter from .*$/m, "import { readFileSync } from 'node:fs';\nconst inter = readFileSync(new URL('../third_party/fonts/inter-latin-400.woff2', import.meta.url));");
mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
const tmp = new URL('../out/worker-run.ts', import.meta.url);
writeFileSync(tmp, src);
globalThis.ExportedHandler = undefined;
const worker = (await import(tmp.href)).default;
for (const t of ['Hello, edge', 'Workers at the edge']) {
  const res = await worker.fetch(new Request(`https://glyph.example/?t=${encodeURIComponent(t)}`));
  const reader = res.body.getReader(); const chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const png = Buffer.concat(chunks), d = decodePng(png);
  const ink = d.px.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);
  console.log(`${JSON.stringify(t)}: ${res.headers.get('content-type')} ${d.width}×${d.height} bpp ${d.bpp}, ${chunks.length} stream chunks, ${png.length} B, ${ink} dark px`);
  if (!ink) process.exitCode = 1;
}
