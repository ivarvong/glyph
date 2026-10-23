// Showcase renders, one per pixel format and a paragraph sheet.
//   node examples/showcase.js [outdir]   (default out/showcase)
//   DPR=3 scales every size and the padding (default 3, for high-DPI screens)
// Prints format, size and warm encode time for each, so the renders carry their own evidence.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { autoBrotli } from '../woff2/src/brotli.js';
import { loadFont, renderText } from '../render/src/text.js';
import { rasterize, scanline, flattenCache } from '../render/src/raster.js';
import { encodePng, fastZlib } from '../render/src/png.js';
import { pngStream } from '../render/src/stream.js';
import { decodePng, toRgba } from '../verify/pngdecode.js';
import { NOOP_SPAN } from '../otel-compact/src/trace.js';

const dir = process.argv[2] ?? new URL('../out/showcase/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const load = async (f) => (await loadFont(new Uint8Array(readFileSync(new URL(`../third_party/fonts/${f}`, import.meta.url))), { brotli: autoBrotli })).value;
const inter = await load('inter-latin-400.woff2');
const serif = await load('source-serif-4-regular.otf.woff2');

const INK = [17, 17, 17, 255], ORANGE = [243, 128, 32, 255], WHITE = [255, 255, 255, 255];
const DPR = Number(process.env.DPR ?? 3);
const L = (font, fontKey, text, size, fill = INK) => ({ font, fontKey, text, size: size * DPR, fill });

/** px between lines per shot; the sheet keeps generous spacing, prose gets book leading */
const GAP = { sheet: 14, prose: 6 };
const SHOTS = [
  ['cloudflare-gray', [L(inter, 'inter', 'Cloudflare', 160, [0, 0, 0, 255])], WHITE],
  ['cloudflare-rgb', [L(inter, 'inter', 'Cloudflare', 160, ORANGE)], WHITE],
  ['cloudflare-rgba', [L(inter, 'inter', 'Cloudflare', 160, ORANGE)], [0, 0, 0, 0]],
  ['sheet', [
    L(inter, 'inter', 'Workers', 72, ORANGE),
    L(serif, 'serif', 'A pure-JS WOFF2 renderer, shaped and rasterised at the edge.', 26),
    L(inter, 'inter', 'The quick brown fox jumps over the lazy dog. 0123456789', 20),
    L(serif, 'serif', 'The quick brown fox jumps over the lazy dog. office · affine · ﬁ ﬂ', 20),
    L(inter, 'inter', 'AVATAR  Tokyo  WAVE  “quotes” — dashes', 32),
    L(serif, 'serif', 'Kerning: AV To Ty Wa LT  ·  Ligatures: fi fl ffi', 32),
    L(inter, 'inter', 'gray · RGB · RGBA — chosen per scene, losslessly', 15, [110, 110, 110, 255]),
  ], WHITE],
  ['prose', [
    L(serif, 'serif', 'Edge rendering', 40),
    ...[
      'Cloudflare Workers provides a serverless execution environment that',
      'allows you to create new applications or augment existing ones without',
      'configuring or maintaining infrastructure. Each glyph here is flattened',
      'once per size and then translated into place: repeated letters are a',
      'memo hit, so outline work grows with the alphabet, not the text.',
    ].map((t) => L(serif, 'serif', t, 18)),
    ...[
      'Inter sets the same idea in a grotesque: quick brown foxes, lazy dogs,',
      'office affine fjord — ligatures, kerning, and contextual alternates.',
    ].map((t) => L(inter, 'inter', t, 16, [70, 70, 70, 255])),
  ], WHITE],
];

for (const [name, lines, background] of SHOTS.filter(([n]) => !process.env.ONLY || n === process.env.ONLY)) {
  const r = await renderText(lines, { padding: 24 * DPR, gap: (GAP[name] ?? 0) * DPR, background, targets: [] });
  if (r.tag === 'Err') throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const { scene } = r.value;
  const cache = flattenCache();
  const once = async () => encodePng(rasterize(scene, scanline, NOOP_SPAN, { cache }), fastZlib);
  for (let i = 0; i < 10; i++) await once();
  const ts = [];
  let png = new Uint8Array();
  for (let i = 0; i < 30; i++) { const t = performance.now(); png = await once(); ts.push(performance.now() - t); }
  const ch = rasterize(scene, scanline).channels;
  // Write the file through the banded ReadableStream; it must decode to the same pixels.
  const streamed = new Uint8Array(await new Response(pngStream(scene, scanline, fastZlib, { cache })).arrayBuffer());
  if (Buffer.compare(Buffer.from(toRgba(decodePng(streamed))), Buffer.from(toRgba(decodePng(png))))) throw new Error(`${name}: banded pixels differ`);
  writeFileSync(`${dir}/${name}@${DPR}x.png`, streamed);
  console.log(`${name.padEnd(16)} ${scene.width}×${scene.height}  ${{ 1: 'gray', 3: 'RGB', 4: 'RGBA' }[ch].padEnd(4)}  ${(png.length / 1024).toFixed(1).padStart(5)} KiB  raster+png p50 ${ts.sort((a, b) => a - b)[15].toFixed(2)} ms`);
}
