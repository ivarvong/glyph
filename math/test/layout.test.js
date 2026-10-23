// Math layout: each rule checked as a property stated by its source (the MATH constants, the
// TeXbook's spacing table, MathML Core's stretching), not by re-deriving the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFont } from '../../sfnt/src/font.js';
import { mathOf, parseMath } from '../src/table.js';
import { parseTex } from '../src/tex.js';
import { layoutMath, inkBounds } from '../src/layout.js';
import { typeset } from '../src/typeset.js';
import { findUndefined } from '../../fuzz/target.js';
import { CORPUS } from '../../verify/math-corpus.js';

const root = new URL('../../', import.meta.url).pathname;
const font = (await loadFont(new Uint8Array(readFileSync(root + 'third_party/fonts/latinmodern-math.otf')))).value;
const M = mathOf(font).value, C = M.constants;
const lay = (tex, display = false, math = M) => {
  const ast = parseTex(tex);
  assert.equal(ast.tag, 'Ok', tex);
  const r = layoutMath(font, math, ast.value, { display });
  assert.equal(r.tag, 'Ok', `${tex}: ${JSON.stringify(r.error)}`);
  return r.value;
};
const gid = (cp) => font.glyphOf(cp);
const ink = (g) => inkBounds(font.path(g).value);
const eps = 1e-6;
/** Ink box of the glyph placed for `g` (first occurrence), in layout units. */
const placed = (box, g) => {
  const p = box.glyphs.find((x) => x.gid === g);
  assert.ok(p, `glyph ${g} placed`);
  const b = ink(g);
  return { x: p.x, y: p.y, k: p.k, x0: p.x + b[0] * p.k, x1: p.x + b[2] * p.k, y0: p.y + b[1] * p.k, y1: p.y + b[3] * p.k };
};

test('inkBounds is exact: on-curve extremes inside the control hull, and ≥ every flattened point', () => {
  for (const g of [gid(0x1d465), gid(0x28), gid(0x221a), 3074, gid(0x1d453)]) {
    const p = font.path(g).value, b = ink(g);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, cx = 0, cy = 0;
    for (const s of p) {
      if (s.tag === 'CubicTo') {
        for (let i = 0; i <= 200; i++) {
          const t = i / 200, u = 1 - t;
          const x = u * u * u * cx + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x;
          const y = u * u * u * cy + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
      if ('x' in s) { cx = s.x; cy = s.y; x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); }
    }
    assert.ok(b[0] <= x0 + eps && b[2] >= x1 - eps && b[1] <= y0 + eps && b[3] >= y1 - eps, `g${g} contains samples`);
    assert.ok(x0 - b[0] < 0.01 && b[2] - x1 < 0.01 && y0 - b[1] < 0.01 && b[3] - y1 < 0.01, `g${g} tight: ${b} vs ${[x0, y0, x1, y1]}`);
  }
});

test('spacing: TeXbook p. 170 between atom classes; medium and thick spaces vanish in script styles; Bin becomes Ord (rules 5, 6)', () => {
  const mu = font.unitsPerEm / 18;
  const xs = (tex) => lay(tex).glyphs.map((g) => g.x);
  const a = gid(0x1d44e), b = gid(0x1d44f), plus = gid(0x2b), eq = gid(0x3d), minus = gid(0x2212), comma = gid(0x2c);
  const adv = (g) => font.advance(g);
  // a+b: Ord Bin Ord, 4 mu each side. a=b: 5 mu. a,b: Punct then thin space after.
  assert.deepEqual(xs('a+b').map(Math.round), [0, adv(a) + 4 * mu, adv(a) + 8 * mu + adv(plus)].map(Math.round));
  assert.deepEqual(xs('a=b').map(Math.round), [0, adv(a) + 5 * mu, adv(a) + 10 * mu + adv(eq)].map(Math.round));
  assert.deepEqual(xs('a,b').map(Math.round), [0, adv(a), adv(a) + adv(comma) + 3 * mu].map(Math.round));
  // Unary minus: a Bin at the start, after Rel or Open, is an Ord: no space.
  assert.equal(Math.round(xs('-a')[1]), adv(minus));
  assert.equal(Math.round(xs('a=-b')[2] - xs('a=-b')[1]), Math.round(adv(eq) + 5 * mu));
  assert.equal(Math.round(xs('(-a)')[2] - xs('(-a)')[1]), adv(minus));
  // A Bin before a Rel or at the end is an Ord too (rule 6): a+= has + as Ord.
  assert.equal(Math.round(xs('a+=')[1]), adv(a));
  // Script style: x^{a+b} has no medium spaces (the table's parenthesised entries).
  const sup = lay('x^{a+b}').glyphs;
  assert.equal(Math.round(sup[2].x - sup[1].x), Math.round(adv(a) * 0.7));
  // \, \; \quad are 3, 5, 18 mu of the current style.
  assert.equal(Math.round(xs('a\\,b')[1] - adv(a)), Math.round(3 * mu));
  assert.equal(Math.round(xs('a\\quad b')[1] - adv(a)), font.unitsPerEm);
  // Op and Ord: thin space, also in script style (unparenthesised).
  assert.equal(Math.round(xs('\\sin x')[3] - xs('\\sin x')[2] - adv(gid(0x6e))), Math.round(3 * mu));
});

test('italic correction: before a superscript and after a slanted item, not between two slanted items (MathML Core §3.3.1.2, §3.4.1.3)', () => {
  const f = gid(0x1d453), icf = M.italics.get(f), adv = font.advance(f);
  assert.ok(icf > 0);
  const sup = lay('f^2').glyphs;
  assert.equal(sup[1].x, adv + icf);
  const sub = lay('f_2').glyphs;
  assert.equal(sub[1].x, adv);
  assert.equal(lay('f)').glyphs[1].x, adv + icf);
  assert.equal(lay('ff').glyphs[1].x, adv, 'two slanted items: no correction between them');
  assert.equal(M.italics.get(gid(0x1d465)) ?? 0, 0);
  assert.equal(lay('fx').glyphs[1].x, adv + icf, 'x has none, so it is not slanted: f gets its correction');
  assert.equal(lay('f').width, adv + icf);
});

test('scripts: shifts at least the MATH minimums, sub/sup gap ≥ SubSuperscriptGapMin, cramped superscripts lower', () => {
  const x = gid(0x1d465), two = gid(0x32), i = gid(0x1d456);
  const s = lay('x^2'), p = placed(s, two);
  assert.ok(p.y >= C.SuperscriptShiftUp - eps && p.y0 - 0 >= C.SuperscriptBottomMin - eps);
  const b = lay('x_i'), q = placed(b, i);
  assert.ok(-q.y >= C.SubscriptShiftDown - eps && q.y1 <= C.SubscriptTopMax + eps);
  const bs = lay('x_i^2'), sup = placed(bs, two), sub = placed(bs, i);
  assert.ok(sup.y0 - sub.y1 >= C.SubSuperscriptGapMin - eps, `gap ${sup.y0 - sub.y1}`);
  assert.ok(sup.k === 0.7 && sub.k === 0.7);
  // Cramped (in a denominator): the superscript rises SuperscriptShiftUpCramped, not SuperscriptShiftUp.
  const fr = lay('\\frac{1}{x^2}');
  const den = fr.glyphs.find((g) => g.gid === x), sup2 = fr.glyphs.find((g) => g.gid === two && g.y > den.y);
  assert.ok(sup2.y - den.y >= C.SuperscriptShiftUpCramped * 0.7 - eps && sup2.y - den.y < C.SuperscriptShiftUp * 0.7);
  // Second-level scripts are scriptscript (50%) and stay there.
  assert.deepEqual(lay('x^{y^{z^w}}').glyphs.map((g) => g.k), [1, 0.7, 0.5, 0.5]);
});

test('fractions: bar on the axis, gaps at least the display/text minimums, null delimiter space; \\binom stacks without a bar', () => {
  for (const [tex, disp] of [['\\frac{x}{y}', true], ['\\frac{x}{y}', false], ['\\dfrac{x}{y}', false], ['\\tfrac{x}{y}', true]]) {
    const f = lay(tex, disp), isD = tex.startsWith('\\dfrac') || (disp && !tex.startsWith('\\tfrac'));
    const bar = f.rules[0], t = C.FractionRuleThickness, k = isD ? 1 : 0.7;
    assert.ok(Math.abs(bar.y + bar.h / 2 - C.AxisHeight) < eps && bar.h === t);
    const n = placed(f, gid(0x1d465)), d = placed(f, gid(0x1d466));
    assert.ok(n.y0 - (bar.y + t) >= (isD ? C.FractionNumDisplayStyleGapMin : C.FractionNumeratorGapMin) - eps, tex);
    assert.ok(bar.y - d.y1 >= (isD ? C.FractionDenomDisplayStyleGapMin : C.FractionDenominatorGapMin) - eps, tex);
    assert.ok(n.y >= (isD ? C.FractionNumeratorDisplayStyleShiftUp : C.FractionNumeratorShiftUp) - eps && n.k === k, tex);
    assert.equal(bar.x, 0.12 * font.unitsPerEm);
  }
  const b = lay('\\binom{n}{k}', true);
  assert.equal(b.rules.length, 0);
  const n = placed(b, gid(0x1d45b)), k = placed(b, gid(0x1d458));
  assert.ok(n.y0 - k.y1 >= C.StackDisplayStyleGapMin - eps);
});

test('stretchy delimiters: cover the content, symmetric about the axis; size variants first, then an assembly', () => {
  const axis = C.AxisHeight;
  for (const tex of ['\\left(\\frac{a}{b}\\right)', '\\left(\\frac{\\frac{a}{b}}{\\frac{c}{d}}\\right)', '\\left[\\begin{matrix}1\\\\2\\\\3\\\\4\\\\5\\\\6\\end{matrix}\\right]']) {
    const f = lay(tex, true);
    let top = -Infinity, bot = Infinity;
    for (const g of f.glyphs) {
      const b = ink(g.gid);
      if (f.glyphs.indexOf(g) === 0 || g.x >= f.glyphs[f.glyphs.length - 1].x - eps) continue;
      top = Math.max(top, g.y + b[3] * g.k); bot = Math.min(bot, g.y + b[1] * g.k);
    }
    for (const r of f.rules) { top = Math.max(top, r.y + r.h); bot = Math.min(bot, r.y); }
    const open = f.tokens[0];
    assert.ok(open.top >= top - 1 && open.bottom <= bot + 1, `${tex}: delimiter ${open.bottom}..${open.top} covers ${bot}..${top}`);
    assert.ok(Math.abs((open.top + open.bottom) / 2 - axis) < 1, `${tex}: centred on the axis`);
  }
  // \left( around a six-row matrix is taller than the largest variant (2991): an assembly of parts with overlaps ≥ minConnectorOverlap.
  const big = lay('\\left(\\begin{matrix}1\\\\2\\\\3\\\\4\\\\5\\\\6\\\\7\\\\8\\end{matrix}\\right)', true);
  const parts = M.vertical.get(gid(0x28)).assembly.parts.map((p) => p.gid);
  const used = big.glyphs.filter((g) => parts.includes(g.gid));
  assert.ok(used.length >= 3, `${used.length} parts`);
  const first = used.filter((g) => g.x === used[0].x).sort((a, b) => a.y - b.y);
  for (let j = 1; j < first.length; j++) {
    const full = M.vertical.get(gid(0x28)).assembly.parts.find((p) => p.gid === first[j - 1].gid).full;
    assert.ok(first[j - 1].y + full - first[j].y >= M.minConnectorOverlap - eps, 'overlap');
  }
});

test('large operators: display picks the variant reaching DisplayOperatorMinHeight; limits use the limit constants; \\int keeps scripts', () => {
  const d = lay('\\sum_{i}^{n}', true), t = lay('\\sum_{i}^{n}', false);
  const sumD = d.glyphs[0].gid, sumT = t.glyphs[0].gid;
  const vd = M.vertical.get(gid(0x2211)).variants.find((v) => v.gid === sumD);
  assert.ok(vd && vd.advance >= C.DisplayOperatorMinHeight && sumT === gid(0x2211));
  const op = placed(d, sumD), n = placed(d, gid(0x1d45b)), i = placed(d, gid(0x1d456));
  assert.ok(n.y0 - op.y1 >= C.UpperLimitGapMin - eps && n.y - op.y1 >= C.UpperLimitBaselineRiseMin - eps);
  assert.ok(op.y0 - i.y1 >= C.LowerLimitGapMin - eps && op.y0 - i.y >= C.LowerLimitBaselineDropMin - eps);
  assert.ok(Math.abs((op.y0 + op.y1) / 2 - C.AxisHeight) < 1, 'centred on the axis');
  // Text style: scripts beside. \int in display: scripts beside too (\nolimits), the superscript right of the subscript by the italic correction.
  assert.ok(placed(t, gid(0x1d45b)).x > placed(t, sumT).x1 - 1);
  const ig = lay('\\int_0^1', true), I = ig.glyphs[0];
  const one = ig.glyphs.find((g) => g.gid === gid(0x31)), zero = ig.glyphs.find((g) => g.gid === gid(0x30));
  assert.equal(one.x - zero.x, M.italics.get(I.gid));
});

test('radicals: surd covers the radicand plus gap and rule; index raised by RadicalDegreeBottomRaisePercent', () => {
  const r = lay('\\sqrt{x}', true), bar = r.rules[0];
  const x = placed(r, gid(0x1d465));
  assert.ok(bar.y - x.y1 >= C.RadicalDisplayStyleVerticalGap - eps && bar.h === C.RadicalRuleThickness);
  const surd = r.glyphs[0];
  assert.ok(Math.abs(surd.y + ink(surd.gid)[3] - (bar.y + bar.h)) < 1, 'surd top meets the bar top');
  const r3 = lay('\\sqrt[3]{x}'), three = placed(r3, gid(0x33));
  assert.ok(three.k === 0.5 && three.x === C.RadicalKernBeforeDegree);
});

test('accents attach at the base\'s top accent point (OpenType), stretchy ones cover the base', () => {
  const x = gid(0x1d465), hat = gid(0x302);
  const a = lay('\\hat{x}'), h = a.glyphs.find((g) => g.gid === hat);
  assert.equal(h.x + M.topAccent.get(hat), M.topAccent.get(x));
  assert.ok(placed(a, hat).y0 >= C.AccentBaseHeight - eps);
  const w = lay('\\widehat{xyz}'), wide = w.glyphs.find((g) => g.gid !== x && g.gid !== gid(0x1d466) && g.gid !== gid(0x1d467));
  const v = M.horizontal.get(hat).variants.find((q) => q.gid === wide.gid);
  assert.ok(v && v.advance >= 3 * 0.5 * font.advance(x), 'a wider variant');
});

test('math kerns (synthetic MATH table): a negative top-right kern pulls the superscript in', () => {
  const f = gid(0x1d443); // P
  const withKern = { ...M, kerns: new Map([[f, { TopRight: { heights: [500], kerns: [-80, -20] }, TopLeft: null, BottomRight: { heights: [], kerns: [-30] }, BottomLeft: null }]]) };
  const plain = lay('P^2_2'), kerned = lay('P^2_2', false, withKern);
  const sup = (b) => b.glyphs[2].x, sub = (b) => b.glyphs[1].x;
  assert.equal(sup(plain) - sup(kerned), 80, 'sup bottom below 500: kern -80');
  assert.equal(sub(plain) - sub(kerned), 30);
  // The synthetic table from fontTools parses and lays out (its glyph ids are not this font's, so only totality).
  assert.equal(parseMath(new Uint8Array(readFileSync(root + 'fixtures/test-math-kern.MATH'))).tag, 'Ok');
});

test('errors: a missing glyph is a typed Err with the source offset; typeset reports parse errors as values', () => {
  const r = typeset(font, 'lmm', 'x+\\mathcal{a}', { size: 20 });
  assert.equal(r.tag, 'Err');
  assert.deepEqual(r.error, { tag: 'Layout', error: { tag: 'MissingGlyph', cp: 0x1d4b6, at: 11 } });
  assert.deepEqual(typeset(font, 'lmm', '\\frac{1}', { size: 20 }).error, { tag: 'Tex', error: { tag: 'MissingArgument', name: '\\frac', at: 8 } });
  assert.equal(typeset(font, 'lmm', 'x', { size: 0 }).error.tag, 'Size');
});

test('random formulas: typeset is total, finite and bounded', () => {
  const toks = ['x', '1', '+', '=', '{', '}', '^', '_', "'", '\\frac', '\\sqrt', '\\left(', '\\right)', '\\middle|', '\\sum', '\\int',
    '\\limits', '\\text{ab}', '\\hat', '\\widehat', '\\overbrace', '\\binom', '\\mathbb', '\\big(', '\\,', '\\alpha', '\\sin', '\\lim',
    '\\begin{pmatrix}', '\\end{pmatrix}', '&', '\\\\', '\\overline', '\\underline', '\\overset', '\\displaystyle', '\\scriptstyle'];
  let seed = 11, oks = 0;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  for (let k = 0; k < 3000; k++) {
    let s = '';
    for (let j = 1 + rnd(24); j > 0; j--) s += toks[rnd(toks.length)] + (rnd(3) ? '' : ' ');
    const r = typeset(font, 'lmm', s, { size: 24, display: rnd(2) === 1 });
    assert.equal(findUndefined(r), '', s);
    if (r.tag === 'Ok') {
      oks++;
      for (const v of [r.value.width, r.value.ascent, r.value.descent, ...r.value.glyphs.flatMap((g) => [g.x, g.y])]) assert.ok(Number.isFinite(v), s);
    }
  }
  assert.ok(oks > 200, `${oks} laid out`);
});

test('the Chromium corpus (verify/math-corpus.js) typesets: every formula, both styles', () => {
  assert.ok(CORPUS.length >= 40);
  for (const f of CORPUS) for (const display of [true, false]) {
    const r = typeset(font, 'lmm', f.tex, { size: 100, display });
    assert.equal(r.tag, 'Ok', `${f.id}: ${JSON.stringify(r.tag === 'Err' && r.error)}`);
    assert.ok(r.value.tokens.length > 0 && r.value.width > 0, f.id);
  }
});
