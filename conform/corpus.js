// Corpus differential: a seeded sample of Google Fonts, each compressed with Google's WOFF2
// encoder and then decoded by glyph and by three oracles:
//
//   fontTools  on the original .ttf    ground truth for outlines, cmap, advances
//   google     woff2_decompress → fontTools   tells "the encoder normalised it" from "we decoded it wrong"
//   fontkit    on the same .woff2     an independent pure-JS WOFF2 decoder and shaper
//   HarfBuzz   on the original .ttf   shaping (gid, cluster, advance, offset), Latin text
//
//   node conform/corpus.js <list of .ttf paths> [--glyphs 1500] [--limit N]
//
// Outlines compare exactly in canonical form (sfnt/test/canon.js); the first `--glyphs` glyphs of
// each font are compared (all of them for most fonts; it bounds the CJK ones).
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as fontkit from 'fontkit';
import { loadFont } from '../sfnt/src/font.js';
import { jsBrotli } from '../woff2/src/brotli.js';
import { shape } from '../shape/src/shape.js';
import { Seg } from '../outline/src/path.js';
import { canonical, outlineDistance } from '../sfnt/test/canon.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : Number(args[i + 1]); };
const GLYPHS = opt('glyphs', 1500), LIMIT = opt('limit', 1e9);
const HERE = new URL('./', import.meta.url).pathname, EXT = `${HERE}.ext`;
const ROOT = args[0].startsWith('/') ? '' : `${process.cwd()}/`;
const listBase = args[0].replace(/[^/]*$/, '');
const fonts = readFileSync(args[0], 'utf8').trim().split('\n').slice(0, LIMIT).map((p) => (p.startsWith('/') ? p : `${ROOT}${listBase}gfonts/${p}`)).filter(existsSync);
const ENC = `${EXT}/woff2/out/woff2_compress`, DEC = `${EXT}/woff2/out/woff2_decompress`;
const scratch = mkdtempSync(`${tmpdir()}/corpus-`);
const TEXTS = ['The quick brown fox jumps over the lazy dog.', 'office ffi fl AVTo WAVE Type 0123456789', 'Hello, Workers! «quotes» — dash',
  // Marks with no precomposed form, so HarfBuzz's normalisation cannot compose them away and GPOS
  // mark attachment (and mark-to-mark stacking) decides their position.
  'q\u0301 m\u0302 f\u0323 p\u0303 x\u0331 q\u0302\u0301 g\u0330'];

/** Python oracle over many files, one JSON line each. */
const py = (script, input, extra = []) => {
  const r = spawnSync('python3', ['-I', `${HERE}${script}`, ...extra], { input, maxBuffer: 1 << 31 - 1, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${script}: ${r.stderr.slice(0, 400)}`); // bug: dev tool, needs fontTools / uharfbuzz
  return new Map(r.stdout.trim().split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.path, o]; }));
};

// ---- 1. encode with Google's encoder; decode with Google's decoder -----------------------------
const jobs = fonts.map((ttf, i) => {
  const base = `${scratch}/${i}`;
  spawnSync('cp', [ttf, `${base}.ttf`]);
  const e = spawnSync(ENC, [`${base}.ttf`], { encoding: 'utf8' });
  const woff2 = `${base}.woff2`;
  const g = existsSync(woff2) ? (spawnSync('cp', [woff2, `${base}g.woff2`]), spawnSync(DEC, [`${base}g.woff2`], { encoding: 'utf8' })) : null;
  return { ttf, local: `${base}.ttf`, woff2: existsSync(woff2) ? woff2 : '', googleTtf: existsSync(`${base}g.ttf`) ? `${base}g.ttf` : '', encErr: e.status ? (e.stderr || '').slice(0, 100) : '' };
});
console.log(`${fonts.length} fonts; ${jobs.filter((j) => j.woff2).length} encoded by woff2_compress`);


// ---- 3. compare -------------------------------------------------------------------------------
/** fontkit path commands → our Seg path → canonical form. */
const fkCanonical = (glyph) => {
  const segs = [];
  for (const c of glyph.path.commands) {
    const a = c.args;
    if (c.command === 'moveTo') segs.push(Seg.MoveTo(a[0], a[1]));
    else if (c.command === 'lineTo') segs.push(Seg.LineTo(a[0], a[1]));
    else if (c.command === 'quadraticCurveTo') segs.push(Seg.QuadTo(a[0], a[1], a[2], a[3]));
    else if (c.command === 'bezierCurveTo') segs.push(Seg.CubicTo(a[0], a[1], a[2], a[3], a[4], a[5]));
    else if (c.command === 'closePath') segs.push(Seg.Close);
  }
  return canonical(segs);
};

/** First difference between a decoded font view and a reference ('' if none). */
function diff(view, ref) {
  if (view.numGlyphs !== ref.numGlyphs) return `numGlyphs ${view.numGlyphs} vs ${ref.numGlyphs}`;
  if (view.unitsPerEm !== ref.unitsPerEm) return `unitsPerEm ${view.unitsPerEm} vs ${ref.unitsPerEm}`;
  for (const [cp, gid] of Object.entries(ref.cmap)) { const g = view.glyphOf(Number(cp)); if (g !== gid) return `cmap U+${Number(cp).toString(16).padStart(4, '0')} → ${g} vs ${gid}`; }
  for (let g = 0; g < ref.numGlyphs; g++) if (view.advance(g) !== ref.advances[g]) return `advance gid ${g}: ${view.advance(g)} vs ${ref.advances[g]}`;
  for (let g = 0; g < ref.outlines.length; g++) {
    const o = view.outline(g);
    if (o === null) return `outline gid ${g}: error`;
    const d = outlineDistance(o, ref.outlines[g]);
    if (d > 1e-9) return `outline gid ${g}: ${d === Infinity ? 'structure differs' : `max |Δ| ${+d.toFixed(4)}`}`;
  }
  return '';
}

// ---- 2–3. oracles and comparison, a chunk at a time (all outlines at once exceed a JS string) ----
const rows = [];
const CHUNK = 10;
for (let c0 = 0; c0 < jobs.length; c0 += CHUNK) {
  const chunk = jobs.slice(c0, c0 + CHUNK);
  const ft = py('oracle.py', chunk.map((j) => j.local).join('\n'), ['--outlines', String(GLYPHS)]);
  const ftGoogle = py('oracle.py', chunk.filter((j) => j.googleTtf).map((j) => j.googleTtf).join('\n'), ['--outlines', String(GLYPHS)]);
  const hbOut = py('hb.py', chunk.map((j) => JSON.stringify({ path: j.local, texts: TEXTS })).join('\n'));
  for (const j of chunk) await compareOne(j, ft, ftGoogle, hbOut);
  if ((c0 / CHUNK) % 5 === 4) console.log(`  … ${Math.min(c0 + CHUNK, jobs.length)}/${jobs.length}`);
}

/** @param {any} j @param {Map<string, any>} ft @param {Map<string, any>} ftGoogle @param {Map<string, any>} hbOut */
async function compareOne(j, ft, ftGoogle, hbOut) {
  const name = j.ttf.split('/').slice(-2).join('/');
  const row = { font: name, variable: name.includes('['), ours: '', vsFontTools: '', vsGoogle: '', vsFontkit: '', shaping: '', encoder: j.encErr };
  rows.push(row);
  const ref = ft.get(j.local);
  if (!j.woff2) { row.ours = 'not encoded'; return; }
  const bytes = new Uint8Array(readFileSync(j.woff2));
  let f;
  try { f = await loadFont(bytes, { brotli: jsBrotli }); } catch (e) { row.ours = `THREW ${e}`; return; }
  if (f.tag === 'Err') { row.ours = `Err ${JSON.stringify(f.error).slice(0, 140)}`; return; }
  const font = f.value;
  row.ours = 'Ok';
  const ourView = { numGlyphs: font.numGlyphs, unitsPerEm: font.unitsPerEm, glyphOf: font.glyphOf, advance: font.advance,
    outline: (g) => { const p = font.path(g); return p.tag === 'Ok' ? canonical(p.value) : null; } };
  row.vsFontTools = ref && ref.ok ? diff(ourView, ref) : `fontTools: ${ref ? ref.error : 'no result'}`;
  const gref = j.googleTtf ? ftGoogle.get(j.googleTtf) : null;
  row.vsGoogle = gref && gref.ok ? diff(ourView, gref) : 'google decode unavailable';
  // fontkit decodes the same WOFF2; compare it with fontTools, so a disagreement names who is off.
  try {
    const fk = fontkit.create(Buffer.from(bytes));
    const fkView = { numGlyphs: fk.numGlyphs, unitsPerEm: fk.unitsPerEm, glyphOf: (cp) => fk.glyphForCodePoint(cp).id, advance: (g) => fk.getGlyph(g).advanceWidth, outline: (g) => fkCanonical(fk.getGlyph(g)) };
    row.vsFontkit = ref && ref.ok ? diff(fkView, ref) : '';
    row.fontkitVsOurs = row.vsFontkit && !row.vsFontTools ? 'fontkit off, ours matches fontTools' : !row.vsFontkit && row.vsFontTools ? 'ours off, fontkit matches fontTools' : '';
  } catch (e) { row.vsFontkit = `fontkit threw: ${String(e).slice(0, 80)}`; }
  // Shaping vs HarfBuzz, for texts the font covers entirely.
  const hbr = hbOut.get(j.local);
  if (hbr && hbr.ok) {
    for (const text of TEXTS) {
      if ([...text].some((ch) => font.glyphOf(ch.codePointAt(0)) === 0)) continue;
      const s = shape(font, text);
      if (s.tag === 'Err') { row.shaping = `Err ${JSON.stringify(s.error).slice(0, 80)}`; break; }
      const got = s.value.map((x) => [x.gid, x.cluster, x.ax, x.ay, x.dx, x.dy]), want = hbr.shaped[text].map((x) => [x.g, x.cl, x.ax, x.ay, x.dx, x.dy]);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        const k = got.findIndex((g, i) => JSON.stringify(g) !== JSON.stringify(want[i]));
        row.shaping = `"${text.slice(0, 18)}…" at ${k}: ours ${JSON.stringify(got[k] || null)} hb ${JSON.stringify(want[k] || null)}${got.length !== want.length ? ` (lengths ${got.length}/${want.length})` : ''}`;
        break;
      }
      row.shapedTexts = (row.shapedTexts || 0) + 1;
    }
  }
}

// ---- 4. report --------------------------------------------------------------------------------
const n = rows.length, okRows = rows.filter((r) => r.ours === 'Ok');
const count = (k) => okRows.filter((r) => r[k] === '').length;
console.log(`decoded by glyph            ${okRows.length}/${n}${okRows.length < n ? `  (${rows.filter((r) => r.ours !== 'Ok').map((r) => `${r.font}: ${r.ours}`).join('; ')})` : ''}`);
console.log(`= fontTools (original .ttf) ${count('vsFontTools')}/${okRows.length}`);
console.log(`= Google decoder → fontTools ${count('vsGoogle')}/${okRows.length}`);
console.log(`fontkit = fontTools         ${count('vsFontkit')}/${okRows.length}`);
const shaped = okRows.filter((r) => r.shapedTexts || r.shaping);
console.log(`shaping = HarfBuzz          ${shaped.filter((r) => !r.shaping).length}/${shaped.length} fonts covering the Latin texts`);
const show = (label, k) => { const bad = okRows.filter((r) => r[k]); if (bad.length) { console.log(`\n${label} (${bad.length}):`); for (const r of bad.slice(0, 25)) console.log(`  ${r.font}${r.variable ? ' [var]' : ''}: ${r[k]}`); } };
show('glyph vs fontTools', 'vsFontTools'); show('glyph vs Google decoder', 'vsGoogle'); show('fontkit vs fontTools', 'vsFontkit'); show('shaping vs HarfBuzz', 'shaping');
writeFileSync(`${EXT}/corpus-results.json`, JSON.stringify(rows, null, 1));
console.log(`\nper-font results → conform/.ext/corpus-results.json`);
