// node verify/math.js [--html out/math/chromium.html]
// Differential check of math layout against Chromium's MathML Core implementation, same font.
// Each corpus formula (verify/math-corpus.js) is laid out by glyph from LaTeX and by Chromium from
// hand-written MathML, at 100 px (1 px = 10 font units). Two comparisons:
//   tokens  every <mi>/<mn>/<mo>/<mtext> box (getBoundingClientRect, relative to a baseline probe)
//           against glyph's token boxes in document order: left edge, advance, ink top and bottom
//   pixels  Chromium's screenshot against glyph's PNG of the same formulas placed at Chromium's
//           measured origins: IoU of the ink masks (gray < 128)
// Dev-only: a static server + headless_shell (HEADLESS_SHELL, or the newest Playwright headless shell).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadFont } from '../sfnt/src/font.js';
import { typeset, placeMath } from '../math/src/typeset.js';
import { translate } from '../render/src/compose.js';
import { rasterize, scanline } from '../render/src/raster.js';
import { encodePng, fastZlib } from '../render/src/png.js';
import { decodePng, toRgba } from './pngdecode.js';
import { CORPUS } from './math-corpus.js';

const ROOT = new URL('../', import.meta.url).pathname;
const OUT = `${ROOT}out/math/`;
mkdirSync(OUT, { recursive: true });
const PX = 100, ROW = 330, LEFT = 40, W = 1700;
const TOL = Number(process.env.TOL ?? 1); // px at 100 px/em = 0.01 em

function shell() {
  if (process.env.HEADLESS_SHELL) return process.env.HEADLESS_SHELL;
  for (const base of ['/opt/pw-browsers', join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) for (const sub of readdirSync(join(base, d))) {
      for (const exe of ['headless_shell', 'chrome-headless-shell']) if (existsSync(join(base, d, sub, exe))) return join(base, d, sub, exe);
    }
  }
  throw new Error('no headless_shell: set HEADLESS_SHELL'); // bug: dev harness without its browser
}

const H = ROW * CORPUS.length;
const page = `<!doctype html><meta charset=utf-8><style>
@font-face { font-family: LMM; src: url(/third_party/fonts/latinmodern-math.otf); }
html, body { margin: 0; background: #fff; } math { font-family: LMM; font-size: ${PX}px; color: #000; }
.f { position: absolute; left: ${LEFT}px; height: ${ROW}px; line-height: ${ROW}px; white-space: nowrap; font-size: ${PX}px; }
.p { display: inline-block; width: 0; height: 0; }
#out { display: none; }
</style>
${CORPUS.map((f, i) => `<div class=f style="top:${i * ROW}px"><span class=p></span><math${f.display ? ' displaystyle="true"' : ''}>${f.mml}</math></div>`).join('\n')}
<pre id=out></pre>
<script>
document.fonts.load('${PX}px LMM').then(() => {
  const res = [...document.querySelectorAll('.f')].map((d) => {
    const base = d.querySelector('.p').getBoundingClientRect().bottom, m = d.querySelector('math').getBoundingClientRect();
    const toks = [...d.querySelectorAll('mi, mn, mo, mtext')].filter((e) => !e.hasAttribute('data-skip')).map((e) => {
      const r = e.getBoundingClientRect();
      return { kind: e.tagName, text: e.textContent, x: r.left - m.left, w: r.width, top: base - r.top, bottom: base - r.bottom };
    });
    return { left: m.left, base, width: m.width, toks };
  });
  document.getElementById('out').textContent = JSON.stringify({ ua: navigator.userAgent, res });
});
</script>`;

const server = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
  if (req.url === '/third_party/fonts/latinmodern-math.otf') { res.writeHead(200, { 'content-type': 'font/otf' }); res.end(readFileSync(`${ROOT}third_party/fonts/latinmodern-math.otf`)); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/`;
const run = promisify(execFile), SHELL = shell();
const flags = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--force-color-profile=srgb', '--font-render-hinting=none', '--virtual-time-budget=10000'];
const { stdout: dom } = await run(SHELL, [...flags, '--dump-dom', url], { maxBuffer: 1 << 26 });
await run(SHELL, [...flags, `--window-size=${W},${H}`, `--screenshot=${OUT}chromium.png`, url], { maxBuffer: 1 << 26 });
server.close();
const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
if (!m) throw new Error('no output from Chromium'); // bug: harness
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const chrome = JSON.parse(unesc(m[1]));
writeFileSync(`${OUT}chromium.html`, page);

// ---- glyph's side -----------------------------------------------------------------------------
const font = (await loadFont(new Uint8Array(readFileSync(`${ROOT}third_party/fonts/latinmodern-math.otf`)))).value;
const items = [];
const report = [];
let tokTotal = 0, tokAgree = 0, formulasAgree = 0;
// Localised agreement, so one spacing rule does not fail every token after it:
//   V  ink top and bottom (vertical layout and the glyph or variant chosen), W  advance width,
//   G  the horizontal error a token adds: dx(k) − dx(k−1) (a gap that differs, at that place only).
const tally = { V: 0, W: 0, G: 0, n: 0 };
// A horizontal error introduced at a token, attributed by its exact signature (0.2 px):
//   italic-correction  = the previous glyph's italic correction (glyph adds it, Chromium does not)
//   fraction-padding   = k × (0.12 em − 1 px): TeX's \nulldelimiterspace against MathML's mfrac padding
//   mu                 = a whole number of mu at the token's or its neighbour's scale (a spacing rule)
/** @type {{ id: string, k: number, text: string, prev: string, local: number, cause: string }[]} */
const causes = [];
const near = (/** @type {number} */ v, /** @type {number} */ q) => Math.abs(v - q) <= 0.2;
//   accent-attachment  next to a combining accent: glyph attaches at the top accent points, Chromium centres the box
//   previous-width     the previous token's width differs (a stretchy box; a brace Chromium did not stretch)
//   large-op-ic        = a large operator's italic correction, or half of it (limits and scripts beside it)
//   mtd-padding        = 0.4 em or 0.2 em: MathML's mtd padding against amsmath's column separation
//   negative-space     \! : MathML Core has no negative mspace (its width is the CSS width property)
const ACCENT = /[\u0300-\u036f\u20d0-\u20ff]/u;
const cause = (/** @type {number} */ local, /** @type {any} */ prev, /** @type {any} */ cur, /** @type {any} */ ctx) => {
  if (ACCENT.test(ctx.text) || ACCENT.test(ctx.prevText)) return 'accent-attachment';
  if (Math.abs(ctx.prevDw) > TOL && near(local, ctx.prevDw)) return 'previous-width';
  if (prev && prev.ic && near(local, prev.ic)) return 'italic-correction';
  for (const l of ctx.lics) for (const q of [l, -l, l / 2, -l / 2]) if (near(local, q)) return 'large-op-ic';
  for (const q of [0.4, -0.4, 0.2, -0.2]) if (near(local, q * PX)) return 'mtd-padding';
  if (prev && near(local, -PX / 6 + prev.ic) && ctx.prevText && /[a-z\u{1d44e}-\u{1d467}]/u.test(ctx.prevText)) return 'negative-space';
  for (const m of [1, 2, 3, -1, -2, -3]) if (near(local, m * (0.12 * PX - 1))) return 'fraction-padding';
  for (const k of new Set([1, 0.7, 0.5, prev ? prev.k : 1, cur.k])) for (let n = -40; n <= 40; n++) if (n && near(local, (n / 18) * PX * k)) return 'mu';
  for (const k of new Set([1, 0.7, 0.5, prev ? prev.k : 1, cur.k])) for (let n = -40; n <= 40; n++) for (const m of [1, -1]) if (near(local, (n / 18) * PX * k + m * (0.12 * PX - 1))) return 'mu+fraction-padding';
  return 'other';
};
const r1 = (v) => Math.round(v * 10) / 10;
CORPUS.forEach((f, i) => {
  const c = chrome.res[i];
  const r = typeset(font, 'lmm', f.tex, { size: PX, display: f.display });
  if (r.tag === 'Err') { report.push({ id: f.id, error: r.error }); return; }
  const s = r.value.s;
  items.push(...placeMath(r.value, translate(c.left, c.base), [0, 0, 0, 255]));
  const ours = r.value.tokens.map((t) => ({ kind: t.kind, x: t.x * s, w: t.w * s, top: t.top * s, bottom: t.bottom * s, ic: t.ic * s, lic: t.lic * s, k: t.k }));
  const n = Math.min(ours.length, c.toks.length);
  /** @type {any[]} */
  const diffs = [];
  let agree = 0;
  let prevDx = 0;
  for (let k = 0; k < n; k++) {
    const a = ours[k], b = c.toks[k];
    const d = { dx: a.x - b.x, dw: a.w - b.w, dtop: a.top - b.top, dbottom: a.bottom - b.bottom };
    const ok = Object.values(d).every((v) => Math.abs(v) <= TOL);
    const local = d.dx - prevDx;
    prevDx = d.dx;
    tally.n++;
    if (Math.abs(d.dtop) <= TOL && Math.abs(d.dbottom) <= TOL) tally.V++;
    if (Math.abs(d.dw) <= TOL) tally.W++;
    if (Math.abs(local) <= TOL) tally.G++;
    if (Math.abs(local) > TOL) causes.push({ id: f.id, k, text: b.text, prev: k ? c.toks[k - 1].text : '', local: r1(local),
      cause: cause(local, k ? ours[k - 1] : null, a, { text: b.text, prevText: k ? c.toks[k - 1].text : '', prevDw: k ? ours[k - 1].w - c.toks[k - 1].w : 0, lics: ours.slice(0, k).map((t) => t.lic).filter(Boolean) }) });
    if (ok) agree++;
    else diffs.push({ k, text: b.text, local: r1(local), ...Object.fromEntries(Object.entries(d).map(([kk, v]) => [kk, r1(v)])) });
  }
  tokTotal += Math.max(ours.length, c.toks.length);
  tokAgree += agree;
  const all = agree === ours.length && ours.length === c.toks.length;
  if (all) formulasAgree++;
  report.push({ id: f.id, tokens: `${agree}/${Math.max(ours.length, c.toks.length)}`, count: ours.length === c.toks.length ? '' : `count ${ours.length} vs ${c.toks.length}`,
    width: r1(r.value.width - c.width), diffs });
});

// ---- pixels -----------------------------------------------------------------------------------
const scene = { width: W, height: H, background: /** @type {const} */ ([255, 255, 255, 255]), items };
const ourPx = rasterize(scene, scanline).rgba;
writeFileSync(`${OUT}glyph.png`, (await encodePng({ width: W, height: H, channels: 4, data: ourPx }, fastZlib)));
const cp = decodePng(readFileSync(`${OUT}chromium.png`)), chromePx = toRgba(cp);
const iou = CORPUS.map((f, i) => {
  let inter = 0, uni = 0;
  for (let y = i * ROW; y < (i + 1) * ROW && y < cp.height; y++) for (let x = 0; x < Math.min(W, cp.width); x++) {
    const a = ourPx[(y * W + x) * 4] < 128, b = chromePx[(y * cp.width + x) * 4] < 128;
    if (a && b) inter++; if (a || b) uni++;
  }
  return uni ? inter / uni : 1;
});
// Ink agreement within 1 px: the share of each side's ink pixels with the other side's ink in their
// 3×3 neighbourhood (antialiased edges no longer count; a misplaced glyph still does).
const near1 = CORPUS.map((f, i) => {
  const inkA = (x, y) => ourPx[(y * W + x) * 4] < 128, inkB = (x, y) => chromePx[(y * cp.width + x) * 4] < 128;
  const any = (ink, x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (ink(x + dx, y + dy)) return true; return false; };
  let a = 0, b = 0, ma = 0, mb = 0;
  for (let y = i * ROW + 1; y < (i + 1) * ROW - 1 && y < cp.height - 1; y++) for (let x = 1; x < Math.min(W, cp.width) - 1; x++) {
    if (inkA(x, y)) { a++; if (any(inkB, x, y)) ma++; }
    if (inkB(x, y)) { b++; if (any(inkA, x, y)) mb++; }
  }
  return a + b ? (ma + mb) / (a + b) : 1;
});
// Side by side: Chromium in red, glyph in blue, overlap black.
const diff = new Uint8Array(W * H * 4);
for (let p = 0; p < W * H; p++) {
  const a = 255 - ourPx[p * 4], b = p < cp.width * cp.height ? 255 - chromePx[p * 4] : 0;
  diff[p * 4] = 255 - a; diff[p * 4 + 1] = 255 - Math.max(a, b); diff[p * 4 + 2] = 255 - b; diff[p * 4 + 3] = 255;
}
writeFileSync(`${OUT}overlay.png`, await encodePng({ width: W, height: H, channels: 4, data: diff }, fastZlib));

console.log(`${chrome.ua.match(/Chrome\/[\d.]+/)[0]}, Latin Modern Math 1.959 at ${PX} px; token tolerance ${TOL} px (${TOL / PX} em)\n`);
for (const [i, r] of report.entries()) {
  console.log(`${r.id.padEnd(18)} ${r.error ? `ERROR ${JSON.stringify(r.error)}` : `tokens ${r.tokens.padEnd(6)} ink IoU ${iou[i].toFixed(3)}  ink within 1 px ${near1[i].toFixed(3)}  width Δ ${String(r.width).padStart(6)} px ${r.count}`}`);
  if (r.diffs && r.diffs.length && process.env.VERBOSE) for (const d of r.diffs) console.log(`    ${JSON.stringify(d)}`);
}
const byCause = {};
for (const c of causes) byCause[c.cause] = (byCause[c.cause] ?? 0) + 1;
console.log(`\nhorizontal errors introduced (> ${TOL} px), by signature: ${JSON.stringify(byCause)}`);
for (const c of causes.filter((x) => x.cause === 'other')) console.log(`    other: ${c.id} ${c.prev} → ${c.text} ${c.local} px`);
const iouAll = iou.reduce((a, b) => a + b, 0) / iou.length;
console.log(`\nformulas with every token within ${TOL} px: ${formulasAgree}/${CORPUS.length}`);
console.log(`tokens within ${TOL} px (x, width, ink top and bottom): ${tokAgree}/${tokTotal}`);
console.log(`localised: ink top/bottom ${tally.V}/${tally.n}, width ${tally.W}/${tally.n}, horizontal error introduced ${tally.G}/${tally.n}`);
console.log(`ink IoU: mean ${iouAll.toFixed(3)}, min ${Math.min(...iou).toFixed(3)}; ≥ 0.9: ${iou.filter((v) => v >= 0.9).length}/${iou.length}`);
const n1 = near1.reduce((a, b) => a + b, 0) / near1.length;
console.log(`ink within 1 px: mean ${n1.toFixed(3)}, min ${Math.min(...near1).toFixed(3)}; ≥ 0.99: ${near1.filter((v) => v >= 0.99).length}/${near1.length}, ≥ 0.9: ${near1.filter((v) => v >= 0.9).length}/${near1.length}`);
writeFileSync(`${OUT}report.json`, JSON.stringify({ ua: chrome.ua, tol: TOL, formulasAgree, tokAgree, tokTotal, tally, causes, iou, near1, report, chrome: chrome.res }, null, 1));
