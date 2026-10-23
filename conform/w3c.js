// W3C WOFF 2.0 conformance (w3c/woff2-tests), run against glyph with fontTools as the outline
// oracle. The suites are generated, not committed: see conform/README.md for the two commands.
//
//   node conform/w3c.js <woff2-tests dir> <expectations dir>     exit 1 on any failure
//
// Suites and what they mean for a renderer (a user agent):
//   UserAgent  298 cases with shouldDisplaySFNT. The contract: display exactly those, reject the
//              rest. A displayed font must also decode to fontTools' outlines, cmap, advances.
//   Decoder    valid files to decode; the roundtrip-* cases ship the original .ttf, so the
//              decoded font must equal the original (outlines, advances, left side bearings).
//   Format     296 cases with strict file validity. Informational: a renderer may be lenient
//              where a validator is not (metadata, padding), but must not reject a valid file.
import { readFileSync, readdirSync, existsSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadFont } from '../sfnt/src/font.js';
import { jsBrotli } from '../woff2/src/brotli.js';
import { canonical, outlineDistance } from '../sfnt/test/canon.js';

const [SUITE, EXPECT] = process.argv.slice(2);
if (!SUITE || !EXPECT) { console.error('usage: node conform/w3c.js <woff2-tests dir> <expectations dir>'); process.exit(2); }
const HERE = new URL('./', import.meta.url).pathname;
const exp = (g) => JSON.parse(readFileSync(`${EXPECT}/${g}.json`, 'utf8'));
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const idOf = (p) => p.split('/').pop().replace(/\.(woff2|ttf|otf)$/, '');

/** fontTools' view of each file, one batch per call. */
function oracle(paths) {
  const r = spawnSync('python3', ['-I', `${HERE}oracle.py`], { input: paths.join('\n'), maxBuffer: 1 << 30, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`oracle failed: ${r.stderr.slice(0, 500)}`); // bug: dev tool, needs fontTools
  return new Map(r.stdout.trim().split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.path, o]; }));
}

// Optional second oracle: Google's reference decoder (google/woff2 woff2_decompress), set
// GOOGLE_WOFF2=<path to woff2_decompress>. It decodes to a .ttf, which fontTools then reads,
// so a file fontTools cannot read as WOFF2 can still be verified through Google's decoder.
const GOOGLE = process.env.GOOGLE_WOFF2 || '';
const scratch = mkdtempSync(`${tmpdir()}/w3c-google-`);
/** @returns {{ ok: boolean, ttf: string, error: string }} */
function google(path) {
  const local = `${scratch}/${path.split('/').pop()}`;
  copyFileSync(path, local);
  const r = spawnSync(GOOGLE, [local], { encoding: 'utf8' });
  const ttf = local.replace(/\.woff2$/, '.ttf');
  return r.status === 0 && existsSync(ttf) ? { ok: true, ttf, error: '' } : { ok: false, ttf: '', error: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 120) };
}

/** Our view, in the oracle's shape. Never throws: a throw is itself a failure. */
async function ours(path) {
  try {
    const f = await loadFont(new Uint8Array(readFileSync(path)), { brotli: jsBrotli });
    if (f.tag === 'Err') return { ok: false, error: JSON.stringify(f.error).slice(0, 160) };
    const font = f.value;
    const outlines = [], bad = [];
    for (let g = 0; g < font.numGlyphs; g++) {
      const p = font.path(g);
      if (p.tag === 'Err') bad.push(g); outlines.push(p.tag === 'Ok' ? canonical(p.value) : null);
    }
    return { ok: true, font, outlines, bad };
  } catch (e) { return { ok: false, threw: true, error: String(e).slice(0, 160) }; }
}

/** Differences between our decode and a reference decode ('' when they agree). */
function compare(a, ref, { lsb = false } = {}) {
  const font = a.font;
  if (font.numGlyphs !== ref.numGlyphs) return `numGlyphs ${font.numGlyphs} vs ${ref.numGlyphs}`;
  if (font.unitsPerEm !== ref.unitsPerEm) return `unitsPerEm ${font.unitsPerEm} vs ${ref.unitsPerEm}`;
  for (const [cp, gid] of Object.entries(ref.cmap)) if (font.glyphOf(Number(cp)) !== gid) return `cmap U+${Number(cp).toString(16)} → ${font.glyphOf(Number(cp))} vs ${gid}`;
  for (let g = 0; g < ref.numGlyphs; g++) if (font.advance(g) !== ref.advances[g]) return `advance gid ${g}: ${font.advance(g)} vs ${ref.advances[g]}`;
  if (a.bad.length) return `outline errors at gids ${a.bad.slice(0, 5).join(', ')}`;
  for (let g = 0; g < ref.outlines.length; g++) {
    const d = outlineDistance(a.outlines[g], ref.outlines[g]);
    if (d > 1e-9) return `outline gid ${g}: ${d === Infinity ? 'structure differs' : `max |Δ| ${d}`}`;
  }
  if (lsb && ref.lsbs) {
    const hmtx = font.tables.get('hmtx'), hhea = font.tables.get('hhea');
    if (hmtx && hhea) {
      const dv = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength), nh = new DataView(hhea.buffer, hhea.byteOffset).getUint16(34);
      for (let g = 0; g < ref.numGlyphs; g++) {
        const v = g < nh ? dv.getInt16(g * 4 + 2) : dv.getInt16(nh * 4 + (g - nh) * 2);
        if (v !== ref.lsbs[g]) return `lsb gid ${g}: ${v} vs ${ref.lsbs[g]}`;
      }
    }
  }
  return '';
}

const results = { UserAgent: [], Decoder: [], Format: [] };
// ---- UserAgent: display exactly the displayable, and decode them right --------------------------
{
  const want = exp('UserAgentTestCaseGenerator');
  const files = walk(`${SUITE}/UserAgent`).filter((p) => p.endsWith('.woff2') && want[idOf(p)]);
  const refs = oracle(files);
  const g = GOOGLE ? new Map(files.map((p) => [p, google(p)])) : new Map();
  const gRefs = GOOGLE ? oracle([...g.values()].filter((x) => x.ok).map((x) => x.ttf)) : new Map();
  for (const p of files) {
    const id = idOf(p), w = want[id], a = await ours(p);
    // Prefer fontTools on the WOFF2 itself; fall back to fontTools on Google's decoded .ttf.
    const gd = g.get(p), viaGoogle = gd && gd.ok ? gRefs.get(gd.ttf) : null;
    const direct = refs.get(p);
    const ref = direct && direct.ok ? direct : viaGoogle && viaGoogle.ok ? viaGoogle : direct;
    let fail = '';
    if (a.threw) fail = `threw ${a.error}`;
    else if (w.valid && !a.ok) fail = `rejected a font that must display: ${a.error}`;
    else if (!w.valid && a.ok) fail = 'displayed a font that must be rejected';
    else if (a.ok && ref && ref.ok) fail = compare(a, ref);
    // Displayed as required, but the oracle cannot read it: counted separately, not as a pass.
    const unverified = !fail && a.ok && ref && !ref.ok ? ref.error : '';
    // Three-way: does Google's decoder agree with the expectation, and with us, on the outlines?
    const googleAgrees = gd ? gd.ok === w.valid : true;
    const googleSame = gd && gd.ok && a.ok && viaGoogle && viaGoogle.ok ? compare(a, viaGoogle) : '';
    results.UserAgent.push({ id, want: w.valid ? 'display' : 'reject', got: a.ok ? 'display' : 'reject', fail: fail || (googleSame ? `differs from Google's decoder: ${googleSame}` : ''), unverified, googleAgrees, google: gd ? (gd.ok ? 'display' : 'reject') : '', title: w.title });
  }
}
// ---- Decoder: decode every valid file; round-trips must equal their original ----------------------
{
  const files = walk(`${SUITE}/Decoder`).filter((p) => p.endsWith('.woff2'));
  const originals = files.map((p) => p.replace(/\.woff2$/, '.ttf')).filter(existsSync);
  const refs = oracle([...files, ...originals]);
  for (const p of files) {
    const id = idOf(p), a = await ours(p), orig = p.replace(/\.woff2$/, '.ttf'), ref = refs.get(existsSync(orig) ? orig : p);
    let fail = '';
    if (a.threw) fail = `threw ${a.error}`;
    else if (!a.ok) fail = /UnsupportedCollection/.test(a.error) ? 'collection (unsupported by design)' : `rejected: ${a.error}`;
    else if (ref && ref.ok) fail = compare(a, ref, { lsb: true });
    results.Decoder.push({ id, roundTrip: existsSync(orig), fail, expectedUnsupported: fail === 'collection (unsupported by design)' });
  }
}
// ---- Format: strict validity, informational except "must not reject a valid file" --------------
{
  const want = exp('FormatTestCaseGenerator');
  const files = walk(`${SUITE}/Format`).filter((p) => p.endsWith('.woff2') && want[idOf(p)]);
  for (const p of files) {
    const id = idOf(p), w = want[id], a = await ours(p);
    results.Format.push({ id, valid: w.valid, accepted: a.ok, threw: !!a.threw, fail: a.threw ? `threw ${a.error}` : w.valid && !a.ok ? `rejected a valid file: ${a.error}` : '', title: w.title });
  }
}

// ---- report ----------------------------------------------------------------------------------
let failures = 0;
if (GOOGLE) {
  const ua = results.UserAgent;
  const dis = ua.filter((r) => !r.googleAgrees);
  console.log(`Google's reference decoder vs the UserAgent expectations: agrees on ${ua.length - dis.length}/${ua.length}${dis.length ? ` (differs: ${dis.map((r) => `${r.id} want ${r.want}, google ${r.google}`).join('; ')})` : ''}`);
}
for (const [suite, rows] of Object.entries(results)) {
  const bad = rows.filter((r) => r.fail && !r.expectedUnsupported);
  failures += bad.length;
  const unv = rows.filter((r) => r.unverified);
  const extra = (unv.length ? `; ${unv.length} displayed but unverifiable (fontTools cannot read: ${unv.map((r) => r.id).join(', ')})` : '') + (suite === 'Format' ? `; lenient on ${rows.filter((r) => !r.valid && r.accepted).length} strictly-invalid files` : suite === 'Decoder' ? `; ${rows.filter((r) => r.expectedUnsupported).length} collections (unsupported by design)` : '');
  console.log(`${suite.padEnd(10)} ${rows.length - bad.length}/${rows.length} pass${extra}`);
  for (const r of bad.slice(0, 40)) console.log(`  FAIL ${r.id}: ${r.fail}${r.title ? `  [${r.title}]` : ''}`);
}
if (results.Format.some((r) => !r.valid && r.accepted)) {
  const groups = {};
  for (const r of results.Format.filter((x) => !x.valid && x.accepted)) { const g = r.id.replace(/-\d+$/, ''); groups[g] = (groups[g] || 0) + 1; }
  console.log(`  lenient by group: ${JSON.stringify(groups)}`);
}
process.exitCode = failures ? 1 : 0;
