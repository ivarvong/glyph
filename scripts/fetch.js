// npm run fetch: download every third-party input this repo uses (fonts, licence texts, upstream
// tables, the W3C WOFF 2.0 test generators) from pinned URLs, check each sha256, and build what is
// derived from them, checking each output's sha256 too. Nothing third-party is committed.
//
//   node scripts/fetch.js            everything (needs python3 for the Python step, see below)
//   node scripts/fetch.js --runtime  only the two generated runtime modules (Node only; for builds)
//   node scripts/fetch.js --check    verify, offline, that everything is present and intact
//
// Steps, each skipped when its outputs already verify:
//   download  third_party/{fonts,licenses,src}/...           (Node fetch; zero dependencies)
//   runtime   woff2/src/brotli-data.js, shape/src/ccc-data.js (tools/gen_*.js; Node only)
//   python    a venv at third_party/venv with PYTHON_PACKAGES, then
//             ref/make_derived_fonts.py   inter-latin-400.woff, source-serif-4-regular.otf
//             w3c/woff2-tests generators  third_party/w3c/*
//             ref/make_refs.py            third_party/ref/{fonttools-*,hb-shape}.json, ft-*.pgm
//             ref/make_math_ref.py        third_party/ref/fonttools-lmmath.json
//   fuzz      fuzz/regressions/*.recipe.json -> third_party/fuzz/*.bin (fuzz/recipe.js)
// Sources: scripts/manifest.js. Licences and URLs: THIRD_PARTY_NOTICES.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { DOWNLOADS, RUNTIME, BUILT, PYTHON_PACKAGES, COMMITS, UNICODE_VERSION } from './manifest.js';

const ROOT = new URL('../', import.meta.url).pathname;
const TP = `${ROOT}third_party/`;
const args = new Set(process.argv.slice(2));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const fileSha = (p) => (existsSync(p) ? sha256(readFileSync(p)) : null);
const ok = (p, h) => fileSha(p) === h;
const log = (s) => console.log(`fetch: ${s}`);
const die = (s) => { console.error(`fetch: ${s}`); process.exit(1); };
const write = (p, b) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b); };

const RECIPES = `${ROOT}fuzz/regressions/`;
const recipes = () => readdirSync(RECIPES).filter((f) => f.endsWith('.recipe.json')).map((f) => JSON.parse(readFileSync(RECIPES + f, 'utf8')));

// ---- check ------------------------------------------------------------------------------------
/** Every expected output that is missing or has the wrong bytes. */
function problems({ runtimeOnly = false } = {}) {
  const want = [
    ...DOWNLOADS.filter((d) => !runtimeOnly || d.runtime).map((d) => [TP + d.path, d.sha256]),
    ...RUNTIME.map((r) => [ROOT + r.path, r.sha256]),
    ...(runtimeOnly ? [] : [...BUILT.map((b) => [TP + b.path, b.sha256]), ...recipes().map((r) => [`${TP}fuzz/${r.file}`, r.sha256])]),
  ];
  return want.filter(([p, h]) => !ok(p, h)).map(([p]) => p.replace(ROOT, ''));
}
if (args.has('--check')) {
  const bad = problems({ runtimeOnly: args.has('--runtime') });
  if (bad.length) die(`${bad.length} third-party file(s) missing or changed (${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ', ...' : ''}); run \`npm run fetch\``);
  process.exit(0);
}

// ---- download ---------------------------------------------------------------------------------
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 500 * attempt));
    }
  }
}
/** One member of a zip archive (stored or deflated), read via the central directory. */
function unzip(zip, member) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    const method = zip.readUInt16LE(p + 10), size = zip.readUInt32LE(p + 20), nlen = zip.readUInt16LE(p + 28);
    const name = zip.toString('utf8', p + 46, p + 46 + nlen), local = zip.readUInt32LE(p + 42);
    if (name === member) {
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(data, data + size);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`zip method ${method}`);
    }
    p += 46 + nlen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  throw new Error(`${member} not in zip`);
}
const zips = new Map();
async function download(d) {
  const errors = [];
  for (const s of d.sources) {
    try {
      let b;
      if (typeof s === 'string') b = await get(s);
      else {
        if (!zips.has(s.zip)) zips.set(s.zip, get(s.zip));
        const z = await zips.get(s.zip);
        if (sha256(z) !== s.zipSha256) throw new Error(`${s.zip}: sha256 ${sha256(z)}, want ${s.zipSha256}`);
        b = unzip(z, s.member);
      }
      if (sha256(b) !== d.sha256) throw new Error(`${typeof s === 'string' ? s : s.member}: sha256 ${sha256(b)}, want ${d.sha256}`);
      write(TP + d.path, b);
      return;
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`${d.path}:\n  ${errors.join('\n  ')}`);
}
async function downloads(list) {
  const todo = list.filter((d) => !ok(TP + d.path, d.sha256));
  if (!todo.length) return;
  log(`downloading ${todo.length} file(s)`);
  const fails = [];
  for (let i = 0; i < todo.length; i += 8) {
    const rs = await Promise.allSettled(todo.slice(i, i + 8).map(download));
    for (const r of rs) if (r.status === 'rejected') fails.push(r.reason.message);
  }
  if (fails.length) die(`download failed:\n${fails.join('\n')}`);
}

// ---- runtime modules --------------------------------------------------------------------------
async function runtime() {
  const { genBrotliData } = await import('../tools/gen_brotli_data.js');
  const { genCcc } = await import('../tools/gen_ccc.js');
  const src = (dir, files) => Object.fromEntries(files.map((f) => [f, readFileSync(`${TP}src/${dir}/${f}`)]));
  const out = {
    'woff2/src/brotli-data.js': () => genBrotliData(src('brotli', ['transform.c', 'transform.h', 'context.c', 'dictionary.c', 'dictionary.bin']), COMMITS.brotli),
    'shape/src/ccc-data.js': () => genCcc({ ...src('harfbuzz', ['hb-unicode.cc', 'hb-unicode.hh']), ...src('unicode', ['UnicodeData.txt']) }, COMMITS.harfbuzz, UNICODE_VERSION),
  };
  for (const r of RUNTIME) {
    if (ok(ROOT + r.path, r.sha256)) continue;
    const text = out[r.path]();
    if (sha256(text) !== r.sha256) die(`${r.path}: generated sha256 ${sha256(text)}, want ${r.sha256}`);
    write(ROOT + r.path, text);
    log(`generated ${r.path}`);
  }
}

// ---- python -----------------------------------------------------------------------------------
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.error || r.status !== 0) die(`${cmd} ${argv.join(' ')} failed:\n${r.error ? r.error.message : (r.stderr || r.stdout).slice(-2000)}`);
  return r.stdout;
}
function python() {
  const stale = BUILT.filter((b) => !ok(TP + b.path, b.sha256));
  if (!stale.length) return;
  const steps = new Set(stale.map((b) => b.by));
  const venv = `${TP}venv/`;
  const py = process.platform === 'win32' ? `${venv}Scripts/python.exe` : `${venv}bin/python`;
  const stamp = `${venv}.glyph-packages`;
  if (!existsSync(py) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== PYTHON_PACKAGES.join('\n')) {
    const sys = process.env.PYTHON || 'python3';
    log(`creating ${venv.replace(ROOT, '')} with ${sys} (${PYTHON_PACKAGES.join(' ')})`);
    rmSync(venv, { recursive: true, force: true });
    run(sys, ['-m', 'venv', venv]);
    run(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-input', ...PYTHON_PACKAGES]);
    writeFileSync(stamp, PYTHON_PACKAGES.join('\n'));
  }
  if (steps.has('derived')) { log('fontTools: inter-latin-400.woff, source-serif-4-regular.otf'); run(py, ['-I', `${ROOT}ref/make_derived_fonts.py`]); }
  if (steps.has('w3c')) {
    log(`w3c/woff2-tests @ ${COMMITS.woff2Tests.slice(0, 7)}: generating the decoder and user-agent suites`);
    const gen = `${TP}src/woff2-tests/generators`;
    // Not -I: the generators import testCaseGeneratorLib from their own directory.
    for (const g of ['DecoderTestCaseGenerator.py', 'UserAgentTestCaseGenerator.py']) run(py, ['-E', '-s', g], { cwd: gen });
    for (const b of BUILT.filter((x) => x.by === 'w3c')) { mkdirSync(dirname(TP + b.path), { recursive: true }); copyFileSync(TP + b.from, TP + b.path); }
  }
  if (steps.has('refs')) { log('oracles: fontTools, HarfBuzz, FreeType -> third_party/ref/'); run(py, ['-I', `${ROOT}ref/make_refs.py`]); }
  if (steps.has('mathref')) { log('oracles: fontTools MATH -> third_party/ref/fonttools-lmmath.json'); run(py, ['-I', `${ROOT}ref/make_math_ref.py`]); }
  const bad = BUILT.filter((b) => !ok(TP + b.path, b.sha256));
  if (bad.length) die(`built with the wrong bytes (different tool versions?):\n${bad.map((b) => `  ${b.path}: ${fileSha(TP + b.path)}, want ${b.sha256}`).join('\n')}`);
}

// ---- fuzz regressions -------------------------------------------------------------------------
async function fuzz() {
  const todo = recipes().filter((r) => !ok(`${TP}fuzz/${r.file}`, r.sha256));
  if (!todo.length) return;
  const { build } = await import('../fuzz/recipe.js');
  for (const r of todo) write(`${TP}fuzz/${r.file}`, build(r));
  log(`rebuilt ${todo.length} fuzz regression(s) from recipes`);
}

if (args.has('--runtime')) {
  await downloads(DOWNLOADS.filter((d) => d.runtime));
  await runtime();
} else {
  await downloads(DOWNLOADS);
  await runtime();
  python();
  await fuzz();
  const bad = problems();
  if (bad.length) die(`still missing: ${bad.join(', ')}`);
  log('third_party/ complete; every file matches scripts/manifest.js');
}
