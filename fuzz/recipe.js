// Fuzz regressions as recipes: a regression input is a mutated copy of a third-party font, so the
// repo stores how to rebuild it (byte edits against the fetched fonts) instead of its bytes.
// scripts/fetch.js rebuilds every fuzz/regressions/*.recipe.json into third_party/fuzz/ and checks
// its sha256. Dev-only; uses node:zlib (Brotli and zlib encoders) like fuzz/mutate.js.
//
//   node fuzz/recipe.js encode <file.bin>...   write <name>.recipe.json next to each input
//   node fuzz/recipe.js build <recipe.json>    rebuild one (needs npm run fetch's fonts)
//
// A recipe's `build` is a tree of nodes over S, the concatenation of `material(font)` for each
// font in RECIPE_FONTS (the file bytes, its decompressed WOFF2 stream, its inflated WOFF tables):
//   { ops: [[offset, length] | "hex", ...] }   copy runs of S, interleaved with literal bytes
//   { brotli: q, of: node }                   node:zlib Brotli at quality q (default window)
//   { deflate: level, of: node }              node:zlib deflate (zlib format) at level
//   { patch: [[offset, "hex"], ...], of: node }  overwrite bytes of node's output
//   { concat: [node, ...] }
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, deflateSync, inflateSync, constants as Z } from 'node:zlib';

const ROOT = new URL('../', import.meta.url);
/** The fonts a recipe may copy from, in S order (third_party/fonts/). */
export const RECIPE_FONTS = Object.freeze(['inter-latin-400.woff2', 'inter-latin-400.woff', 'source-serif-4-regular.otf.woff2', 'source-serif-4-regular.otf', 'jetbrains-mono-latin-400.woff2']);
const FONT_DIR = new URL('third_party/fonts/', ROOT);

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const cat = (parts) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; };
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const tag = (b, o) => String.fromCharCode(...b.subarray(o, o + 4));

/** WOFF2: offset and length of the compressed stream (header and table directory parsed here). */
function woff2Stream(b) {
  const n = u16(b, 12);
  let o = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const x = b[o++]; v = v * 128 + (x & 0x7f); if (!(x & 0x80)) return v; } throw new Error('base128'); };
  for (let i = 0; i < n; i++) {
    const flags = b[o++];
    if ((flags & 63) === 63) o += 4;
    base128();
    const t = flags & 63, v = flags >> 6;
    if ((t === 10 || t === 11) ? v === 0 : v !== 0) base128(); // transformLength
  }
  if (tag(b, 4) === 'ttcf') throw new Error('collections are not supported');
  return { at: o, length: u32(b, 20) };
}

/** Everything a mutated copy of `b` is likely to reuse: the file, its stream or its tables. */
export function material(b) {
  const parts = [b];
  const magic = tag(b, 0);
  if (magic === 'wOF2') { const s = woff2Stream(b); parts.push(new Uint8Array(brotliDecompressSync(b.subarray(s.at, s.at + s.length)))); }
  if (magic === 'wOFF') {
    for (let i = 0; i < u16(b, 12); i++) {
      const e = 44 + 20 * i, off = u32(b, e + 4), cl = u32(b, e + 8), ol = u32(b, e + 12);
      parts.push(cl === ol ? b.subarray(off, off + cl) : new Uint8Array(inflateSync(b.subarray(off, off + cl))));
    }
  }
  return cat(parts);
}

let cached = null;
export function sourceBuffer() {
  return (cached ||= cat(RECIPE_FONTS.map((f) => material(new Uint8Array(readFileSync(new URL(f, FONT_DIR)))))));
}

/** Evaluate a recipe node against S. */
export function evaluate(node, S) {
  if (node.ops) return cat(node.ops.map((o) => (typeof o === 'string' ? unhex(o) : S.subarray(o[0], o[0] + o[1]))));
  if ('brotli' in node) return new Uint8Array(brotliCompressSync(evaluate(node.of, S), { params: { [Z.BROTLI_PARAM_QUALITY]: node.brotli } }));
  if ('deflate' in node) return new Uint8Array(deflateSync(evaluate(node.of, S), { level: node.deflate }));
  if (node.patch) { const b = Uint8Array.from(evaluate(node.of, S)); for (const [o, h] of node.patch) b.set(unhex(h), o); return b; }
  if (node.concat) return cat(node.concat.map((n) => evaluate(n, S)));
  throw new Error(`recipe: unknown node ${JSON.stringify(node).slice(0, 80)}`);
}

/** Rebuild a recipe; throws unless the result has the recorded sha256. */
export function build(recipe, S = sourceBuffer()) {
  if (JSON.stringify(recipe.fonts) !== JSON.stringify(RECIPE_FONTS)) throw new Error(`${recipe.file}: recipe fonts differ from RECIPE_FONTS`);
  const out = evaluate(recipe.build, S);
  const got = sha256(out);
  if (got !== recipe.sha256) throw new Error(`${recipe.file}: rebuilt sha256 ${got}, recipe says ${recipe.sha256} (${out.length} bytes)`);
  return out;
}

// ---- encoder (dev) ------------------------------------------------------------------------------

/** Greedy copy/literal delta of `tgt` against `src` (copies of at least K bytes). */
export function delta(src, tgt, index, K = 8) {
  const key = (b, i) => { let s = ''; for (let k = 0; k < K; k++) s += String.fromCharCode(b[i + k]); return s; };
  if (!index) {
    index = new Map();
    for (let i = 0; i + K <= src.length; i++) { const k = key(src, i); const a = index.get(k); if (!a) index.set(k, [i]); else if (a.length < 16) a.push(i); }
  }
  const ops = []; let lit = [];
  const flush = () => { if (lit.length) { ops.push(hex(lit)); lit = []; } };
  let i = 0, expect = -1;
  while (i < tgt.length) {
    let best = 0, at = -1;
    const run = (o) => { let l = 0; while (i + l < tgt.length && o + l < src.length && src[o + l] === tgt[i + l]) l++; return l; };
    if (expect >= 0) { const l = run(expect); if (l >= K) { best = l; at = expect; } } // substitutions keep alignment
    if (!best && i + K <= tgt.length) for (const o of index.get(key(tgt, i)) || []) { const l = run(o); if (l > best) { best = l; at = o; } }
    if (best >= K) { flush(); ops.push([at, best]); i += best; expect = at + best; }
    else { lit.push(tgt[i]); i++; if (expect >= 0) expect++; }
  }
  flush();
  return { ops, index };
}
const literalBytes = (node) => JSON.stringify(node).match(/"[0-9a-f]*"/g)?.reduce((n, s) => n + (s.length - 2) / 2, 0) ?? 0;
const prefixLen = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
const suffixLen = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
/** How much of `comp` an encoding `z` already reproduces, from both ends. */
const agree = (z, comp) => prefixLen(z, comp) + suffixLen(z, comp);
const brotliQ = (raw, q) => new Uint8Array(brotliCompressSync(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: q } }));

/** Encode a Brotli stream: exact quality if one reproduces it, else revert mutations until one does. */
function encodeBrotli(comp, S, index) {
  const raw = new Uint8Array(brotliDecompressSync(comp));
  for (let q = 0; q <= 11; q++) if (sha256(brotliQ(raw, q)) === sha256(comp)) return { brotli: q, of: { ops: delta(S, raw, index).ops } };
  // The stream was edited after compression (a whole-file havoc that still decodes). Find the
  // pre-edit raw: undo literal runs of the raw delta, keeping each undo that extends the match.
  let q = 0, best = -1;
  for (let k = 0; k <= 11; k++) { const p = agree(brotliQ(raw, k), comp); if (p > best) { best = p; q = k; } }
  let y = Uint8Array.from(raw);
  const { ops } = delta(S, raw, index);
  let at = 0;
  const runs = [];
  for (const o of ops) { const len = typeof o === 'string' ? o.length / 2 : o[1]; if (typeof o === 'string') runs.push([at, len]); at += len; }
  // Map each literal run to S through the copy before it (the substitution's original bytes).
  let pos = 0, prev = null;
  const orig = new Map();
  for (const o of ops) { const len = typeof o === 'string' ? o.length / 2 : o[1]; if (typeof o === 'string' && prev) orig.set(pos, prev[0] + prev[1] + (pos - prev[2])); if (typeof o !== 'string') prev = [o[0], o[1], pos + o[1]]; pos += len; }
  for (const [p, len] of runs) {
    if (!orig.has(p)) continue;
    // Also try undoing a little further: a mutation may span the copy that follows it.
    const base = y;
    for (let ext = len; ext <= len + 16; ext++) {
      const t2 = Uint8Array.from(base); t2.set(S.subarray(orig.get(p), orig.get(p) + ext), p);
      const a = agree(brotliQ(t2, q), comp);
      if (a > best) { best = a; y = t2; }
    }
  }
  const z = brotliQ(y, q);
  if (z.length !== comp.length) return null;
  const patch = [];
  for (let i = 0; i < z.length; i++) if (z[i] !== comp[i]) { if (patch.length && patch[patch.length - 1][0] + patch[patch.length - 1][1].length / 2 === i) patch[patch.length - 1][1] += hex([comp[i]]); else patch.push([i, hex([comp[i]])]); }
  if (patch.length > 16) return null;
  return { patch, of: { brotli: q, of: { ops: delta(S, y, index).ops } } };
}

/** A recipe for `b`, or null when no compact one was found. */
export function encode(name, b, S = sourceBuffer()) {
  const { index } = delta(S, new Uint8Array(0));
  const plain = (x) => ({ ops: delta(S, x, index).ops });
  let node;
  const magic = tag(b, 0);
  if (magic === 'wOF2') {
    const s = woff2Stream(b);
    const z = encodeBrotli(b.subarray(s.at, s.at + s.length), S, index);
    node = z && { concat: [plain(b.subarray(0, s.at)), z, plain(b.subarray(s.at + s.length))] };
  } else if (magic === 'wOFF') {
    const parts = [];
    const ents = Array.from({ length: u16(b, 12) }, (_, i) => { const e = 44 + 20 * i; return { off: u32(b, e + 4), cl: u32(b, e + 8), ol: u32(b, e + 12) }; }).sort((x, y) => x.off - y.off);
    let at = 0;
    for (const e of ents) {
      if (e.off < at) { parts.length = 0; break; } // overlapping tables: fall back to plain
      parts.push(plain(b.subarray(at, e.off)));
      const c = b.subarray(e.off, e.off + e.cl);
      let n = null;
      if (e.cl < e.ol) { try { const raw = new Uint8Array(inflateSync(c)); for (let l = 1; l <= 9 && !n; l++) if (sha256(deflateSync(raw, { level: l })) === sha256(c)) n = { deflate: l, of: plain(raw) }; } catch { /* not zlib */ } }
      parts.push(n || plain(c));
      at = e.off + e.cl;
    }
    node = parts.length ? { concat: [...parts, plain(b.subarray(at))] } : plain(b);
  } else node = plain(b);
  if (!node) return null;
  const recipe = { file: name, sha256: sha256(b), bytes: b.length, fonts: RECIPE_FONTS, literalBytes: literalBytes(node), build: node };
  build(recipe, S); // round-trip or throw
  return recipe;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const [cmd, ...files] = process.argv.slice(2);
  for (const f of files) {
    if (cmd === 'encode') {
      const name = f.split('/').pop();
      const r = encode(name, new Uint8Array(readFileSync(f)));
      if (!r) { console.log(`${name}: no compact recipe found`); process.exitCode = 1; continue; }
      const out = f.replace(/\.bin$/, '.recipe.json');
      writeFileSync(out, JSON.stringify(r) + '\n');
      console.log(`${name}: ${r.bytes} bytes -> recipe ${JSON.stringify(r).length} bytes (${r.literalBytes} literal bytes) ${out}`);
    } else if (cmd === 'build') {
      const r = JSON.parse(readFileSync(f, 'utf8'));
      console.log(`${r.file}: ${build(r).length} bytes, sha256 ok`);
    } else { console.error('usage: node fuzz/recipe.js encode <file.bin>... | build <recipe.json>...'); process.exit(2); }
  }
}
