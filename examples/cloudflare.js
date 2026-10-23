// node examples/cloudflare.js            -> out/*.svg, out/*.png
// OTEL_COMPACT=jsonl:out/render.jsonl node examples/cloudflare.js   (traced)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tracerFromEnv } from '../otel-compact/src/node.js';
import { autoBrotli } from '../woff2/src/brotli.js';
import { loadFont, renderText } from '../render/src/text.js';

const t = (() => { const r = tracerFromEnv(process.env, { service: 'glyph', resource: { example: 'cloudflare' } }); if (r.tag === 'Ok') return r.value; console.error(r.error); process.exit(2); })();
const FONTS = { inter: 'third_party/fonts/inter-latin-400.woff2', sourceSerif: 'third_party/fonts/source-serif-4-regular.otf.woff2' };
const fixture = (p) => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)));
const outDir = new URL('../out/', import.meta.url);
mkdirSync(outDir, { recursive: true });

await t.span('example.cloudflare', async (s) => {
  const fonts = {};
  for (const [key, path] of Object.entries(FONTS)) {
    const r = await loadFont(fixture(path), { brotli: autoBrotli, span: s });
    if (r.tag !== 'Ok') throw new Error(`${key}: ${JSON.stringify(r.error)}`);
    fonts[key] = r.value;
  }
  // One file per font, then both on one sheet.
  const jobs = [
    ['cloudflare-inter', [{ fontKey: 'inter', font: fonts.inter, text: 'Cloudflare', size: 96 }]],
    ['cloudflare-source-serif', [{ fontKey: 'sourceSerif', font: fonts.sourceSerif, text: 'Cloudflare', size: 96 }]],
    ['cloudflare-sheet', [
      { fontKey: 'inter', font: fonts.inter, text: 'Cloudflare', size: 96 },
      { fontKey: 'sourceSerif', font: fonts.sourceSerif, text: 'Cloudflare', size: 96 },
      { fontKey: 'inter', font: fonts.inter, text: 'Workers · AVAToWaYo · office fluff', size: 24 },
      { fontKey: 'sourceSerif', font: fonts.sourceSerif, text: 'Workers · AVAToWaYo · office fluff', size: 24 },
    ]],
  ];
  for (const [name, lines] of jobs) {
    const r = await renderText(lines, { span: s });
    if (r.tag !== 'Ok') throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    for (const o of r.value.outputs) {
      writeFileSync(new URL(`${name}.${o.ext}`, outDir), o.bytes);
      console.log(`out/${name}.${o.ext}  ${r.value.scene.width}×${r.value.scene.height}  ${o.bytes.length} bytes`);
    }
  }
});
await t.flush();
