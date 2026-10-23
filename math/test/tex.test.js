// TeX subset parser: structure, typed errors with offsets, coverage of every symbol in Latin
// Modern Math, and totality on random token soup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTex } from '../src/tex.js';
import { SYMBOLS, GREEK, BIG_OPS, DELIMS, DELIM_SYMBOLS, ACCENTS, BRACES, NEGATED, styled, ENVIRONMENTS } from '../src/symbols.js';
import { loadFont } from '../../sfnt/src/font.js';
import { findUndefined } from '../../fuzz/target.js';

const root = new URL('../../', import.meta.url).pathname;

/** S-expression of a node: compact enough to assert whole trees. */
function sx(n) {
  const c = (cp) => String.fromCodePoint(cp);
  switch (n.kind) {
    case 'sym': return n.cls === 'ord' ? c(n.cp) : `${n.cls}:${c(n.cp)}`;
    case 'row': return n.items.length === 1 ? sx(n.items[0]) : `[${n.items.map(sx).join(' ')}]`;
    case 'scripts': return `(${sx(n.base)}${n.sub ? `_${sx(n.sub)}` : ''}${n.sup ? `^${sx(n.sup)}` : ''})`;
    case 'bigop': return `op:${c(n.cp)}${n.limits === 'auto' ? '' : `/${n.limits}`}`;
    case 'opname': return `op:${n.name}${n.limits === 'auto' ? '' : `/${n.limits}`}`;
    case 'frac': return `(${n.bar ? 'frac' : 'atop'}${n.style === 'auto' ? '' : n.style}${n.open ? c(n.open) + c(n.close) : ''} ${sx(n.num)} ${sx(n.den)})`;
    case 'sqrt': return `(sqrt${n.index ? `[${sx(n.index)}]` : ''} ${sx(n.body)})`;
    case 'fenced': return `(${n.open ? c(n.open) : '.'} ${n.parts.map(sx).join(` ${n.middles.map(c).join(' ')} `)} ${n.close ? c(n.close) : '.'})`;
    case 'big': return `big${n.em}:${n.cls}:${c(n.cp)}`;
    case 'accent': return `(${n.stretchy ? 'wide' : 'acc'}${c(n.cp)} ${sx(n.base)})`;
    case 'line': return `(${n.under ? 'under' : 'over'}line ${sx(n.base)})`;
    case 'brace': return `(${n.under ? 'under' : 'over'}brace ${sx(n.base)})`;
    case 'stack': return `(${n.cls}:stack ${sx(n.base)}${n.over ? ` ^${sx(n.over)}` : ''}${n.under ? ` _${sx(n.under)}` : ''})`;
    case 'class': return `(${n.cls} ${sx(n.body)})`;
    case 'text': return `"${n.text}"`;
    case 'space': return `${n.mu}mu`;
    case 'style': return `\\${n.style}`;
    case 'matrix': return `(matrix${n.open ? c(n.open) : ''} ${n.rows.map((r) => r.map(sx).join(' & ')).join(' \\\\ ')})`;
  }
}
const parse = (s) => { const r = parseTex(s); assert.equal(r.tag, 'Ok', `${s}: ${JSON.stringify(r.error)}`); return sx(r.value); };

test('structure: scripts, primes, fractions, radicals, fences, operators, accents, alphabets, text, spacing', () => {
  const cases = {
    'x^2_i': '(𝑥_𝑖^2)', "f''(x)": '[(𝑓^[′ ′]) open:( 𝑥 close:)]', "x'^2": '(𝑥^[′ 2])', '^2': '([]^2)',
    'a+b=c': '[𝑎 bin:+ 𝑏 rel:= 𝑐]', 'a-b*c': '[𝑎 bin:− 𝑏 bin:∗ 𝑐]', '\\frac12': '(frac 1 2)',
    '\\dfrac{a}{b}': '(fracD 𝑎 𝑏)', '\\tfrac ab': '(fracT 𝑎 𝑏)', '\\binom{n}{k}': '(atop() 𝑛 𝑘)',
    '\\sqrt[3]{x}': '(sqrt[3] 𝑥)', '\\sqrt2': '(sqrt 2)',
    '\\left(\\frac ab\\middle|c\\right]': '(( (frac 𝑎 𝑏) | 𝑐 ])', '\\left.x\\right\\}': '(. 𝑥 })',
    '\\sum_{i=1}^n': '(op:∑_[𝑖 rel:= 1]^𝑛)', '\\sum\\nolimits_i': '(op:∑/nolimits_𝑖)', '\\int_0^1': '(op:∫/nolimits_0^1)',
    '\\int\\limits_0^1': '(op:∫/limits_0^1)', '\\lim_{x\\to0}': '(op:lim_[𝑥 rel:→ 0])', '\\sin x': '[op:sin/nolimits 𝑥]',
    '\\operatorname{tr}A': '[op:tr/nolimits 𝐴]', '\\operatorname*{argmax}_x': '(op:argmax_𝑥)',
    '\\hat x': '(acĉ 𝑥)', '\\widehat{xy}': '(wide\u0302 [𝑥 𝑦])', '\\vec v': '(acc⃗ 𝑣)', '\\overline{z}': '(overline 𝑧)',
    '\\underline a': '(underline 𝑎)', '\\overbrace{a+b}': '(overbrace [𝑎 bin:+ 𝑏])',
    '\\mathbb{R}^n': '(ℝ^𝑛)', '\\mathcal{L}': 'ℒ', '\\mathfrak{g}': '𝔤', '\\mathbf{v}': '𝐯', '\\mathrm{d}x': '[d 𝑥]',
    '\\mathsf{A}\\mathtt{b}\\mathit{1}': '[𝖠 𝚋 1]', '\\boldsymbol\\alpha': '𝜶', '\\mathbf{\\Gamma}': '𝚪',
    '\\alpha\\Gamma\\varphi\\phi\\epsilon\\varepsilon': '[𝛼 Γ 𝜑 𝜙 𝜖 𝜀]',
    '\\text{if } x>0': '["if " 𝑥 rel:> 0]', 'a\\,b\\;c\\!d\\quad e\\qquad f': '[𝑎 3mu 𝑏 5mu 𝑐 -3mu 𝑑 18mu 𝑒 36mu 𝑓]',
    '\\{x\\}': '[open:{ 𝑥 close:}]', 'a\\le b\\ne c\\to d': '[𝑎 rel:≤ 𝑏 rel:≠ 𝑐 rel:→ 𝑑]', '\\not\\in': 'rel:∉',
    '\\stackrel{?}{=}': '(rel:stack rel:= ^close:?)', '\\overset{\\Delta}{=}': '(rel:stack rel:= ^Δ)',
    '\\mathrel{\\#}': '(rel #)', '\\bigl(x\\bigr)': '[big0.85:open:( 𝑥 big0.85:close:)]',
    '\\displaystyle x': '[\\D 𝑥]', 'x % comment\n+1': '[𝑥 bin:+ 1]', '≤∑α': '[rel:≤ ∑ 𝛼]',
    '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}': '(matrix( 𝑎 & 𝑏 \\\\ 𝑐 & 𝑑)', '\\begin{cases}1&x>0\\\\0&\\text{else}\\\\\\end{cases}': '(matrix{ 1 & [𝑥 rel:> 0] \\\\ 0 & "else")',
    'x \\iff y': '[𝑥 [5mu rel:⟺ 5mu] 𝑦]', '\\ldots\\cdots': '[inner:… inner:⋯]', '\\partial\\nabla\\hbar': '[𝜕 ∇ ℏ]',
  };
  for (const [src, want] of Object.entries(cases)) assert.equal(parse(src), want, src);
});

test('errors are typed values with source offsets', () => {
  const e = (s) => { const r = parseTex(s); assert.equal(r.tag, 'Err', s); return r.error; };
  assert.deepEqual(e('x+\\foo'), { tag: 'UnknownCommand', name: '\\foo', at: 2 });
  assert.deepEqual(e('x^a^b'), { tag: 'DoubleScript', script: 'superscript', at: 3 });
  assert.deepEqual(e('x_a_b'), { tag: 'DoubleScript', script: 'subscript', at: 3 });
  assert.deepEqual(e("x^2'"), { tag: 'DoubleScript', script: 'superscript', at: 3 });
  assert.deepEqual(e('{x'), { tag: 'Unexpected', found: 'end of input', expected: "'}'", at: 2 });
  assert.deepEqual(e('x}'), { tag: 'Unexpected', found: '}', expected: 'end of input', at: 1 });
  assert.deepEqual(e('\\frac{a}'), { tag: 'MissingArgument', name: '\\frac', at: 8 });
  assert.deepEqual(e('\\left( x'), { tag: 'Unexpected', found: 'end of input', expected: '\\right to close \\left', at: 8 });
  assert.deepEqual(e('x\\right)'), { tag: 'Unexpected', found: '\\right', expected: 'end of input', at: 1 });
  assert.deepEqual(e('\\left\\foo x\\right)'), { tag: 'BadDelimiter', found: '\\foo', at: 5 });
  assert.deepEqual(e('\\begin{align}x\\end{align}'), { tag: 'UnknownEnvironment', name: 'align', at: 0 });
  assert.deepEqual(e('\\begin{matrix}x\\end{pmatrix}'), { tag: 'Unexpected', found: '\\end{pmatrix}', expected: '\\end{matrix}', at: 28 });
  assert.deepEqual(e('x\\limits'), { tag: 'Unexpected', found: '\\limits', expected: 'a large operator before \\limits or \\nolimits', at: 8 });
  assert.deepEqual(e('\\not x'), { tag: 'Unexpected', found: '\\not x', expected: 'a relation \\not can negate (=, <, \\in, \\equiv, …)', at: 0 });
  assert.deepEqual(e('a & b'), { tag: 'Unexpected', found: '&', expected: 'end of input', at: 2 });
  assert.deepEqual(e('$x$'), { tag: 'Unexpected', found: '$', expected: 'a math character (escape it as \\$)', at: 0 });
  assert.equal(e('x'.repeat(4097)).tag, 'TooLong');
  assert.equal(e('{'.repeat(40) + '}'.repeat(40)).tag, 'TooDeep');
  assert.equal(e('\\sqrt'.repeat(100) + 'x').tag, 'TooDeep');
});

test('every symbol, Greek letter, operator, delimiter, accent and math-alphabet letter is in Latin Modern Math', async () => {
  const font = (await loadFont(new Uint8Array(readFileSync(root + 'third_party/fonts/latinmodern-math.otf')))).value;
  const cps = new Set([
    ...Object.values(SYMBOLS).map((x) => x[0]), ...Object.values(GREEK), ...Object.values(BIG_OPS).map((x) => x[0]),
    ...Object.values(DELIMS).filter(Boolean), ...Object.values(DELIM_SYMBOLS).map((x) => x[0]), ...Object.values(ACCENTS).map((x) => x[0]),
    ...Object.values(BRACES).map((x) => x[0]), ...Object.values(NEGATED), ...Object.values(ENVIRONMENTS).flat().filter(Boolean), 0x2032, 0x221a,
  ]);
  for (const v of ['default', 'italic', 'bold', 'bold-italic', 'double-struck', 'script', 'fraktur', 'sans-serif', 'monospace']) {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') cps.add(styled(ch.codePointAt(0), v));
    for (const g of Object.values(GREEK)) cps.add(styled(g, v));
  }
  // Latin Modern Math has no lowercase script alphabet (𝒶–𝓏 and the holes ℯ ℊ ℴ): \mathcal{a} is a
  // MissingGlyph error at layout, as it is an error in LaTeX with unicode-math and this font.
  const scriptLower = new Set(Array.from('abcdefghijklmnopqrstuvwxyz', (ch) => styled(ch.codePointAt(0), 'script')));
  const missing = [...cps].filter((cp) => font.glyphOf(cp) === 0);
  assert.deepEqual(missing.filter((cp) => !scriptLower.has(cp)).map((cp) => `U+${cp.toString(16)}`), []);
  assert.equal(missing.length, 26);
  assert.ok(cps.size > 900, `${cps.size} code points`);
});

test('random token soup: always Ok or a typed Err, never a throw or an undefined, bounded time', () => {
  const toks = ['x', '1', '+', '=', '{', '}', '^', '_', "'", '\\frac', '\\sqrt', '[', ']', '\\left(', '\\right)', '\\middle|',
    '\\sum', '\\limits', '\\text{a}', '\\hat', '\\mathbb', '&', '\\\\', '\\begin{matrix}', '\\end{matrix}', '\\,', '\\not', '\\foo',
    '\\left', '\\right', ' ', '%', '\n', '\\alpha', '\\big', '(', ')', '\\operatorname', '\\overset', '\\', '$', '~', 'é', '𝑥'];
  let seed = 3;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  const tags = new Map();
  const t0 = performance.now();
  for (let k = 0; k < 20000; k++) {
    let s = '';
    const n = 1 + rnd(30);
    for (let j = 0; j < n; j++) s += toks[rnd(toks.length)];
    const r = parseTex(s);
    const t = r.tag === 'Ok' ? 'Ok' : r.error.tag;
    tags.set(t, (tags.get(t) ?? 0) + 1);
    assert.equal(findUndefined(r), '', s);
    if (r.tag === 'Err' && 'at' in r.error) assert.ok(r.error.at >= 0 && r.error.at <= s.length, `${s}: ${JSON.stringify(r.error)}`);
  }
  const ms = performance.now() - t0;
  assert.ok(tags.get('Ok') > 500 && tags.size >= 5, JSON.stringify([...tags]));
  assert.ok(ms < 5000, `${ms} ms`);
});
