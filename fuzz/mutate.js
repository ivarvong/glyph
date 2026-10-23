// Mutators for font files, from dumb to structure-aware. Dev-only: uses node:zlib to re-pack, so
// mutations land *inside* compressed containers and reach the table parsers, not just Brotli.
//
//   havoc(bytes)        bit flips, interesting integers, arithmetic, chunk copy/insert/delete, truncation
//   woff2Stream(bytes)  decompress a WOFF2's Brotli stream, havoc the table data in place, recompress
//   tables(bytes)       decode to sfnt tables, havoc one table (field-aligned), re-pack as sfnt | WOFF | WOFF2
//   splice(a, b)        swap one table of `a` for the same table of `b`
import { portOf } from '../woff2/src/brotli.js';
import { brotliCompressSync, brotliDecompressSync, deflateSync, constants as Z } from 'node:zlib';
import { readContainer, KNOWN_TAGS } from '../woff2/src/woff2.js';
import { openFontFile } from '../sfnt/src/containers.js';

/** Seeded PRNG (xorshift-mix); every mutation is reproducible from (seed, input). */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
  return { next, int: (n) => Math.floor(next() * n), pick: (a) => a[Math.floor(next() * a.length)], chance: (p) => next() < p };
}

const I8 = [0, 1, 0x7f, 0x80, 0xff];
const I16 = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xfffe, 0xffff];
const I32 = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0x10000, 0xffff, 0x100000];

/** In-place-or-resized havoc: `n` random edits. */
export function havoc(bytes, r, n = 1 + r.int(8), { resize = true } = {}) {
  let b = Uint8Array.from(bytes);
  for (let k = 0; k < n && b.length; k++) {
    const at = r.int(b.length);
    switch (r.int(resize ? 10 : 7)) {
      case 0: b[at] ^= 1 << r.int(8); break;
      case 1: b[at] = r.int(256); break;
      case 2: b[at] = r.pick(I8); break;
      case 3: if (at + 2 <= b.length) { const v = r.pick(I16); b[at] = v >> 8; b[at + 1] = v & 255; } break;
      case 4: if (at + 4 <= b.length) { const v = r.pick(I32); b[at] = v >>> 24; b[at + 1] = (v >>> 16) & 255; b[at + 2] = (v >>> 8) & 255; b[at + 3] = v & 255; } break;
      case 5: if (at + 2 <= b.length) { const v = (((b[at] << 8) | b[at + 1]) + (r.int(65) - 32)) & 0xffff; b[at] = v >> 8; b[at + 1] = v & 255; } break;
      case 6: { const len = 1 + r.int(Math.min(64, b.length)); const src = r.int(Math.max(1, b.length - len)); b.copyWithin(at, src, src + len); break; }
      case 7: { const len = 1 + r.int(32); const ins = new Uint8Array(len).map(() => (r.chance(0.5) ? 0 : r.int(256))); const o = new Uint8Array(b.length + len); o.set(b.subarray(0, at)); o.set(ins, at); o.set(b.subarray(at), at + len); b = o; break; }
      case 8: { const len = 1 + r.int(Math.min(64, b.length - at)); const o = new Uint8Array(b.length - len); o.set(b.subarray(0, at)); o.set(b.subarray(at + len), at); b = o; break; }
      case 9: b = b.subarray(0, Math.max(0, at)); break;
    }
  }
  return b;
}

/** Field-aligned havoc for table data: writes land on 2- or 4-byte boundaries, like real fields. */
function fieldHavoc(bytes, r) {
  const b = Uint8Array.from(bytes);
  const n = 1 + r.int(4);
  for (let k = 0; k < n && b.length >= 4; k++) {
    const at = (r.int(b.length - 3)) & ~1;
    if (r.chance(0.6)) { const v = r.pick(I16); b[at] = v >> 8; b[at + 1] = v & 255; }
    else if (r.chance(0.5)) { const v = r.pick(I32); b[at] = v >>> 24; b[at + 1] = (v >>> 16) & 255; b[at + 2] = (v >>> 8) & 255; b[at + 3] = v & 255; }
    else b[at + r.int(2)] ^= 1 << r.int(8);
  }
  return b;
}

/** WOFF2: mutate the decompressed table stream (same length), recompress, rebuild the file. */
export function woff2Stream(bytes, r) {
  const c = readContainer(bytes);
  if (c.tag === 'Err') return null;
  let raw;
  try { raw = brotliDecompressSync(c.value.compressed); } catch { return null; }
  const mutated = havoc(raw, r, 1 + r.int(6), { resize: false });
  const comp = brotliCompressSync(mutated, { params: { [Z.BROTLI_PARAM_QUALITY]: 1 + r.int(5) } });
  const start = c.value.compressed.byteOffset - bytes.byteOffset;
  const out = new Uint8Array(start + comp.length);
  out.set(bytes.subarray(0, start)); out.set(comp, start);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, out.length); dv.setUint32(20, comp.length);
  return out;
}

// ---- table-level: decode to tables, mutate one, re-pack ------------------------------------------
async function decodeTables(bytes) {
  const f = await openFontFile(bytes, { brotli: portOf((b) => new Uint8Array(brotliDecompressSync(b))) });
  if (f.tag === 'Err') return null;
  // Only untransformed tables can be re-packed as sfnt/WOFF; keep transformed glyf for WOFF2 only.
  return f.value;
}

const pad4 = (n) => (n + 3) & ~3;
function packSfnt(flavor, tables) {
  const n = tables.length, head = 12 + 16 * n;
  let size = head; for (const t of tables) size += pad4(t.data.length);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, flavor === 'OTTO' ? 0x4f54544f : 0x00010000); dv.setUint16(4, n);
  let off = head;
  tables.forEach((t, i) => {
    for (let k = 0; k < 4; k++) out[12 + i * 16 + k] = t.tag.charCodeAt(k);
    dv.setUint32(12 + i * 16 + 8, off); dv.setUint32(12 + i * 16 + 12, t.data.length);
    out.set(t.data, off); off += pad4(t.data.length);
  });
  return out;
}
function packWoff(flavor, tables) {
  const packed = tables.map((t) => { const z = deflateSync(t.data); return z.length < t.data.length ? z : t.data; });
  const n = tables.length, head = 44 + 20 * n;
  let size = head; for (const p of packed) size += pad4(p.length);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x774f4646); dv.setUint32(4, flavor === 'OTTO' ? 0x4f54544f : 0x00010000); dv.setUint32(8, size); dv.setUint16(12, n);
  let off = head;
  tables.forEach((t, i) => {
    const e = 44 + i * 20;
    for (let k = 0; k < 4; k++) out[e + k] = t.tag.charCodeAt(k);
    dv.setUint32(e + 4, off); dv.setUint32(e + 8, packed[i].length); dv.setUint32(e + 12, t.data.length);
    out.set(packed[i], off); off += pad4(packed[i].length);
  });
  return out;
}
function base128(n) { const o = []; do { o.unshift(n & 0x7f); n = Math.floor(n / 128); } while (n); return o.map((b, i) => (i < o.length - 1 ? b | 0x80 : b)); }
/** WOFF2 with every table untransformed (glyf/loca: transform version 3, the null transform). */
function packWoff2(flavor, tables, r) {
  const dir = [];
  for (const t of tables) {
    const idx = KNOWN_TAGS.indexOf(t.tag);
    const version = t.tag === 'glyf' || t.tag === 'loca' ? 3 : 0;
    if (idx >= 0) dir.push((version << 6) | idx); else { dir.push((version << 6) | 63, ...[...t.tag].map((c) => c.charCodeAt(0))); }
    dir.push(...base128(t.data.length));
  }
  const stream = new Uint8Array(tables.reduce((n, t) => n + t.data.length, 0));
  let o = 0; for (const t of tables) { stream.set(t.data, o); o += t.data.length; }
  const comp = brotliCompressSync(stream, { params: { [Z.BROTLI_PARAM_QUALITY]: 1 + r.int(4) } });
  const out = new Uint8Array(48 + dir.length + comp.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x774f4632); dv.setUint32(4, flavor === 'OTTO' ? 0x4f54544f : 0x00010000); dv.setUint32(8, out.length);
  dv.setUint16(12, tables.length); dv.setUint32(16, 12 + 16 * tables.length + tables.reduce((n, t) => n + pad4(t.data.length), 0)); dv.setUint32(20, comp.length);
  out.set(dir, 48); out.set(comp, 48 + dir.length);
  return out;
}

export async function tables(bytes, r, donor) {
  const f = await decodeTables(bytes);
  if (!f) return null;
  let ts = f.tables.map((t) => ({ tag: t.tag, transform: t.transform?.tag ?? 'Identity', data: t.data }));
  const plain = ts.every((t) => t.transform === 'Identity');
  if (donor) {
    const d = await decodeTables(donor);
    if (d) {
      const dt = r.pick(d.tables);
      if ((dt.transform?.tag ?? 'Identity') === 'Identity') ts = ts.filter((t) => t.tag !== dt.tag).concat([{ tag: dt.tag, transform: 'Identity', data: dt.data }]);
    }
  }
  const pick = r.pick(ts.filter((t) => t.transform === 'Identity'));
  if (pick) pick.data = r.chance(0.7) ? fieldHavoc(pick.data, r) : havoc(pick.data, r, 1 + r.int(4));
  if (!plain) return null; // transformed glyf cannot be re-packed untransformed without a decoder; woff2Stream covers it
  ts.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const which = r.int(3);
  return which === 0 ? packSfnt(f.flavor, ts) : which === 1 ? packWoff(f.flavor, ts) : packWoff2(f.flavor, ts, r);
}
export { packSfnt, packWoff, packWoff2, decodeTables };
