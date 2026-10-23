// Range: specimen posters rendered by glyph from real Google Fonts (the corpus-verified sample:
// every face here decodes and shapes exactly as fontTools / Google's decoder / HarfBuzz do).
//   node examples/range.js [outdir]     DPR=3 by default. Fonts from conform/.ext/gfonts (npm run conform setup).
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadFont } from '../index.js';
import { scanline, flattenCache, channelsFor } from '../render/src/raster.js';
import { balancedZlib } from '../render/src/png.js';
import { pngStream } from '../render/src/stream.js';
import { run, must, place, translate, chain, hex, onCircle, circle, ring, roundRect } from '../render/src/compose.js';
import { parseGdef } from '../shape/src/layout.js';
import { DEFAULT_GPOS } from '../shape/src/shape.js';

const ROOT = new URL('../', import.meta.url).pathname;
const dir = process.argv[2] || `${ROOT}out/range/`;
mkdirSync(dir, { recursive: true });
const D = Number(process.env.DPR || 3);
const LIST = readFileSync(`${ROOT}conform/.ext/gf-sample.txt`, 'utf8').trim().split('\n');

/** A face from the sample by file-name prefix. Over 16 MiB as .ttf? Compress it with Google's encoder first, as a server would. */
async function face(prefix) {
  const p = LIST.find((x) => x.split('/').pop().startsWith(prefix));
  if (!p) throw new Error(`no ${prefix} in the sample`); // bug: script data
  let path = `${ROOT}conform/.ext/gfonts/${p}`;
  if (readFileSync(path).length > 16 << 20) {
    const tmp = `${ROOT}out/range-fonts/`; mkdirSync(tmp, { recursive: true });
    const ttf = `${tmp}${prefix}.ttf`, woff2 = `${tmp}${prefix}.woff2`;
    if (!existsSync(woff2)) { copyFileSync(path, ttf); spawnSync(`${ROOT}conform/.ext/woff2/out/woff2_compress`, [ttf]); }
    path = woff2;
  }
  const font = must(await loadFont(new Uint8Array(readFileSync(path))));
  const gdef = font.tables.get('GDEF');
  const g = gdef ? parseGdef(gdef) : { tag: 'Err' };
  return { font, key: prefix, isMark: (gid) => g.tag === 'Ok' && g.value.glyphClass(gid) === 3 };
}
/** Shape in one face; a character it cannot map is an error, never a .notdef box. */
const R = (f, text, size, opts = {}) => {
  const rn = must(run(f.font, f.key, text, size * D, { ...opts, tracking: (opts.tracking || 0) * D }));
  if (rn.missing) throw new Error(`${f.key} lacks ${rn.missing} character(s) of ${JSON.stringify(text)}`); // bug: script data
  return rn;
};
const at = (x, y) => translate(x * D, y * D);
const W = 1200 * D, H = 1500 * D;

// Palette: warm paper and soft ink, with five accents that sit together.
const PAPER = hex('#F3EEE4'), INK = hex('#17150F'), NIGHT = hex('#0F1014'), MUTED = hex('#8C8577'), DIM = hex('#6D6E78');
const VERMILION = hex('#E2522B'), OCHRE = hex('#E9A23B'), TEAL = hex('#2B8A8F'), PLUM = hex('#7B5EA7'), SAGE = hex('#7FA36B'), ROSE = hex('#E58FA8');

const F = {
  mono: await face('CascadiaCode-Italic'), monoUp: await face('SplineSansMono'),
  fat: await face('AbrilFatface'), italic: await face('Cormorant-Italic'), grotesk: await face('SpaceGrotesk'),
  slab: await face('ZillaSlab-Bold'), inline: await face('FascinateInline'), shadow: await face('LondrinaShadow'),
  puddles: await face('RubikPuddles'), pixel: await face('Jacquard12Charted'), stencil: await face('BlackOpsOne'),
  didone: await face('GildaDisplay'), italiana: await face('Italiana'), glaze: await face('KalniaGlaze'),
  hand: await face('PlaywriteUSModern'), handFR: await face('PlaywriteFRTrad'), pacifico: await face('Pacifico'),
  yellowtail: await face('Yellowtail'), formal: await face('PetitFormalScript'), luxurious: await face('LuxuriousScript'),
  beau: await face('BeauRivage'), fleur: await face('FleurDeLeah'), lobster: await face('LobsterTwo-Bold'),
  charis: await face('CharisSIL-Bold'), gentium: await face('GentiumPlus-Bold'), baskerville: await face('LibreBaskerville-Italic'),
  playfair: await face('PlayfairDisplaySC-Black'),
};

/** Small mono label, tracked out. */
const label = (text, x, y, fill = MUTED, size = 12) => place(R(F.monoUp, text.toUpperCase(), size, { tracking: 2.2 }), at(x, y), fill);
const centered = (rn, y) => translate((W - rn.width) / 2, y * D);
const footer = (items, text, fill) => items.push(...label(text, 64, 1450, fill, 11));

// ---------------------------------------------------------------------------------- 1. range
function range() {
  const items = [];
  items.push(...label('glyph · range', 64, 92, DIM, 13));
  items.push(...place(R(F.italic, 'Fourteen faces, one engine', 54), at(64, 170), hex('#EDE8DD')));
  const cells = [
    [F.fat, 'Fatface', 'Abril Fatface · display', VERMILION, 96],
    [F.hand, 'Joined up', 'Playwrite US Modern · script', OCHRE, 74],
    [F.italic, 'Cormorant', 'Cormorant Italic · garalde', hex('#EDE8DD'), 104],
    [F.grotesk, 'Grotesk', 'Space Grotesk · sans', TEAL, 98],
    [F.inline, 'INLINE', 'Fascinate Inline · decorative', ROSE, 92],
    [F.slab, 'Slab serif', 'Zilla Slab Bold · slab', SAGE, 92],
    [F.shadow, 'SHADOW', 'Londrina Shadow · display', OCHRE, 104],
    [F.didone, 'Didone', 'Gilda Display · didone', hex('#EDE8DD'), 104],
    [F.puddles, 'Puddles', 'Rubik Puddles · novelty', PLUM, 92],
    [F.pixel, 'Pixels', 'Jacquard 12 Charted · bitmap', VERMILION, 104],
    [F.stencil, 'STENCIL', 'Black Ops One · stencil', SAGE, 84],
    [F.mono, 'code => ok', 'Cascadia Code Italic · mono', TEAL, 70],
  ];
  const colW = 536, rowH = 184, x0 = 64, y0 = 300;
  cells.forEach(([f, word, cap, fill, size], k) => {
    const x = x0 + (k % 2) * colW, y = y0 + Math.floor(k / 2) * rowH;
    items.push(roundRect(x * D, (y - 30) * D, (colW - 24) * D, (rowH - 24) * D, 18 * D, hex('#17181E')));
    items.push(...label(cap, x + 26, y + 6, DIM, 10.5));
    const rn = R(f, word, size);
    const fit = Math.min(1, ((colW - 76) * D) / rn.width);
    items.push(...place(fit < 1 ? R(f, word, size * fit) : rn, at(x + 26, y + 118), fill));
  });
  footer(items, 'woff2 / shape / flatten / scan / deflate · plain javascript · 3600 x 4500', DIM);
  return { width: W, height: H, background: NIGHT, items };
}

// ---------------------------------------------------------------------------------- 2. hand
function hand() {
  const items = [];
  items.push(...label('cursive · joined by gpos', 64, 92));
  const a = R(F.hand, 'The quick brown fox', 84), b = R(F.hand, 'jumps over the lazy dog', 84);
  items.push(...place(a, at(64, 300), INK), ...place(b, at(64, 470), INK));
  items.push(...place(R(F.handFR, 'écriture à la main, liée', 54), at(64, 610), VERMILION));
  const rows = [
    [F.pacifico, 'Pacifico', 64, TEAL], [F.yellowtail, 'Yellowtail', 70, PLUM], [F.formal, 'Petit Formal Script', 52, INK],
    [F.luxurious, 'Luxurious Script', 76, OCHRE], [F.beau, 'Beau Rivage', 84, SAGE], [F.fleur, 'Fleur De Leah', 80, ROSE],
    [F.lobster, 'Lobster Two', 70, VERMILION],
  ];
  let y = 780;
  for (const [f, name, size, fill] of rows) {
    items.push(...place(R(f, name, size), at(64, y), fill));
    y += 96;
  }
  // A word around a circle, in the joined script: cursive attachment survives any transform.
  // The radius is set by the text's own width, so the letters keep their natural (joined) spacing.
  const word = R(F.hand, 'handwriting, handwriting, ', 40);
  items.push(...onCircle(word, { cx: 930 * D, cy: 1010 * D, r: word.width / (2 * Math.PI), start: -Math.PI / 2 }, INK));
  items.push(circle(940 * D, 1010 * D, 8 * D, VERMILION));
  footer(items, 'playwrite · pacifico · yellowtail · petit formal · luxurious · beau rivage · fleur de leah · lobster two');
  return { width: W, height: H, background: PAPER, items };
}

// ---------------------------------------------------------------------------------- 3. marks
function marks() {
  const items = [];
  items.push(...label('accents · placed by gpos mark & mark-to-mark', 64, 92));
  /** Bases in ink, every mark glyph in vermilion: the attachment is the picture. */
  const tinted = (f, base = INK, mark = VERMILION) => (i, g) => (f.isMark(g.gid) ? mark : base);
  // Decomposed (NFD) so every accent is its own glyph, positioned by the font's anchors.
  const hero = 'ự ẫ ḉ ǘ'.normalize('NFD');
  const rn = R(F.charis, hero, 250);
  items.push(...place(rn, centered(rn, 470), tinted(F.charis)));
  const stack = R(F.charis, 'q̂́ ṏ ẍ̌ ǻ'.normalize('NFD'), 150);
  items.push(...place(stack, centered(stack, 760), tinted(F.charis, INK, TEAL)));
  const lines = [
    [F.gentium, 'Tiếng Việt có dấu: tôi yêu tiếng nước tôi', 44],
    [F.gentium, 'Đắk Lắk · Hồ Chí Minh · Phở bò · Nguyễn', 44],
    [F.charis, 'Ǆemal · Ǿresund · Ṩeṃ · Ẓẹḅṛạ · Ŵẁẃẅ', 44],
    [F.charis, 'Ṯḫe ṯïḿẽ ḧäṡ çöṁë', 44],
  ];
  let y = 960;
  for (const [f, text, size] of lines) {
    const r = R(f, text.normalize('NFD'), size);
    items.push(...place(r, at(64, y), tinted(f, INK, VERMILION)));
    y += 92;
  }
  footer(items, 'charis sil bold · gentium plus bold · text decomposed (nfd): every accent is a separate glyph on its anchor');
  return { width: W, height: H, background: PAPER, items };
}

// ---------------------------------------------------------------------------------- 4. world
async function world() {
  const items = [];
  items.push(...label('scripts · one renderer', 64, 92, DIM));
  const faces = {
    hangul: await face('GamjaFlower'), kana: await face('RampartOne'), magic: await face('YuseiMagic'), shufa: await face('MaShanZheng'),
    serifSC: await face('NotoSerifSC'), cherokee: await face('NotoSansCherokee'), runic: await face('NotoSansRunic'),
    gothic: await face('NotoSansGothic'), linearB: await face('NotoSansLinearB'), vai: await face('NotoSansVai'),
    olchiki: await face('NotoSansOlChiki'), mayan: await face('NotoSansMayanNumerals'), anatolian: await face('NotoSansAnatolianHieroglyphs'),
    dokdo: await face('Dokdo'),
  };
  const cells = [
    [faces.serifSC, '字体渲染', 'Han · Noto Serif SC', hex('#EDE8DD'), 108],
    [faces.shufa, '书法', 'Han · Ma Shan Zheng', VERMILION, 128],
    [faces.hangul, '한글 글꼴', 'Hangul · Gamja Flower', OCHRE, 108],
    [faces.kana, 'ひらがな', 'Kana · Rampart One', TEAL, 100],
    [faces.cherokee, 'ᏣᎳᎩ', 'Cherokee · Noto Sans', ROSE, 112],
    [faces.runic, 'ᚠᚢᚦᚨᚱᚲ', 'Runic · Noto Sans', SAGE, 108],
    [faces.gothic, '𐌲𐌿𐍄𐌰𐍃', 'Gothic · Noto Sans', OCHRE, 108],
    [faces.linearB, '𐀀𐀁𐀂𐀃𐀄', 'Linear B · Noto Sans', PLUM, 104],
    [faces.vai, 'ꕙꔤ ꕉꕜꕮ', 'Vai · Noto Sans', hex('#EDE8DD'), 104],
    [faces.olchiki, 'ᱚᱞ ᱪᱤᱠᱤ', 'Ol Chiki · Noto Sans', TEAL, 108],
    [faces.anatolian, '𔐀𔐁𔐂𔐃', 'Anatolian hieroglyphs · Noto Sans', VERMILION, 84],
    [faces.mayan, '𝋠 𝋥 𝋪 𝋯 𝋳', 'Mayan numerals 0 5 10 15 19 · Noto Sans', SAGE, 92],
  ];
  const colW = 536, rowH = 196, x0 = 64, y0 = 250;
  cells.forEach(([f, word, cap, fill, size], k) => {
    const x = x0 + (k % 2) * colW, y = y0 + Math.floor(k / 2) * rowH;
    items.push(roundRect(x * D, (y - 30) * D, (colW - 24) * D, (rowH - 24) * D, 18 * D, hex('#17181E')));
    items.push(...label(cap, x + 26, y + 6, DIM, 10.5));
    const rn = R(f, word, size);
    const fit = Math.min(1, ((colW - 76) * D) / rn.width);
    items.push(...place(fit < 1 ? R(f, word, size * fit) : rn, at(x + 26, y + 124), fill));
  });
  const dok = R(faces.dokdo, '독도', 60);
  items.push(...place(dok, at(1200 - 64 - dok.width / D, 92 + 20), DIM));
  footer(items, 'left-to-right scripts with simple shaping · arabic, hebrew and indic shaping are not done yet', DIM);
  return { width: W, height: H, background: NIGHT, items };
}

// ---------------------------------------------------------------------------------- 5. kern
function kern() {
  const items = [];
  items.push(...label('kerning & ligatures', 64, 92));
  // Unkerned as a ghost, kerned in ink on top: the gap closing is the kerning.
  const noKern = new Set([...DEFAULT_GPOS].filter((f) => f !== 'kern'));
  const words = [['AVATAR', 230, 400], ['Typo', 260, 690], ['WAVY', 230, 950]];
  for (const [w, size, y] of words) {
    const plain = R(F.fat, w, size, { gposFeatures: noKern }), kerned = R(F.fat, w, size);
    items.push(...place(plain, centered(plain, y), hex('#DDD5C6')));
    items.push(...place(kerned, centered(kerned, y), INK));
  }
  // Ligatures: a glyph whose cluster spans more than one character is a ligature: in vermilion.
  const lig = (text) => (rn) => (i) => {
    const next = i + 1 < rn.glyphs.length ? rn.glyphs[i + 1].cluster : [...text].length;
    return next - rn.glyphs[i].cluster > 1 ? VERMILION : INK;
  };
  const t1 = 'office affluent fjord', t2 = 'The fifth difficult flight';
  const l1 = R(F.baskerville, t1, 64), l2 = R(F.baskerville, t2, 64);
  items.push(...place(l1, at(64, 1170), lig(t1)(l1)), ...place(l2, at(64, 1270), lig(t2)(l2)));
  footer(items, 'abril fatface: gpos kern on (ink) vs off (ghost) · libre baskerville italic: gsub ligatures in red');
  return { width: W, height: H, background: PAPER, items };
}

// ---------------------------------------------------------------------------------- 6. big
function big() {
  const items = [];
  const amp = R(F.playfair, '&', 1500);
  items.push(...place(amp, translate((W - amp.width) / 2, 1250 * D), hex('#25221B')));
  for (let i = 0; i < 7; i++) items.push(ring(W / 2, 760 * D, (230 + i * 46) * D, 1.1 * D, [233, 162, 59, 150 - i * 18]));
  const t = R(F.italic, 'Type, at any size', 96);
  items.push(...place(t, centered(t, 1340), PAPER));
  items.push(...label('playfair display sc black · 1500 px at 3× · exact coverage on every curve', 64, 1450, MUTED, 11));
  return { width: W, height: H, background: INK, items };
}

const SCENES = { range, hand, marks, world, kern, big };
for (const [name, build] of Object.entries(SCENES).filter(([n]) => !process.env.ONLY || n === process.env.ONLY)) {
  const t = performance.now();
  const scene = await build();
  const png = new Uint8Array(await new Response(pngStream(scene, scanline, balancedZlib, { cache: flattenCache() })).arrayBuffer());
  writeFileSync(`${dir}${name}@${D}x.png`, png);
  console.log(`${name.padEnd(7)} ${scene.width}×${scene.height} ${({ 1: 'gray', 3: 'RGB', 4: 'RGBA' })[channelsFor(scene)].padEnd(4)} ${String(scene.items.length).padStart(5)} glyphs+shapes  ${(png.length / 1024).toFixed(0).padStart(5)} KiB  ${(performance.now() - t).toFixed(0)} ms`);
}
