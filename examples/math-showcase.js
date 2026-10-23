// node examples/math-showcase.js [out.png]
// The math showcase: LaTeX in, Latin Modern Math's MATH table, glyph's Scene → PNG. Labels are
// \text in the same font; nothing else draws text.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadFont, draw, typeset, placeMath, translate } from '../index.js';

const ROOT = new URL('../', import.meta.url).pathname;
const out = process.argv[2] ?? `${ROOT}out/math/showcase.png`;
mkdirSync(new URL('.', `file://${out}`).pathname, { recursive: true });
const f = await loadFont(new Uint8Array(readFileSync(`${ROOT}third_party/fonts/latinmodern-math.otf`)));
if (f.tag === 'Err') throw new Error(JSON.stringify(f.error)); // bug: the fixture font
const font = f.value;

const W = 1600, INK = [23, 21, 15, 255], RUST = [194, 65, 12, 255], GREY = [120, 113, 108, 255];
const SECTIONS = [
  ['The quadratic formula', ['x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}']],
  ["Euler's identity", ['e^{i\\pi} + 1 = 0']],
  ['The Gaussian integral', ['\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}']],
  ["Cauchy's integral formula", ['f(a) = \\frac{1}{2\\pi i} \\oint_\\gamma \\frac{f(z)}{z - a}\\,dz']],
  ["Maxwell's equations", [
    '\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0} \\qquad \\nabla \\cdot \\mathbf{B} = 0',
    '\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t} \\qquad \\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}',
  ]],
  ['The binomial theorem', ['\\left( x + y \\right)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^{n-k} y^k']],
  ['A continued fraction, a matrix, cases', [
    '\\frac{1}{1 + \\cfrac{1}{1 + \\cfrac{1}{1 + \\cdots}}} \\qquad \\begin{pmatrix} \\cos\\theta & -\\sin\\theta \\\\ \\sin\\theta & \\cos\\theta \\end{pmatrix} \\qquad |x| = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}',
  ]],
  ['Accents, limits, alphabets', [
    '\\lim_{n \\to \\infty} \\left( 1 + \\frac{1}{n} \\right)^n = e \\qquad \\hat{x}\\,\\vec{v}\\,\\widehat{xyz}\\,\\overline{z} \\qquad \\mathbb{R}^n \\supseteq \\mathcal{L} \\ni \\mathfrak{g}',
  ]],
];

const items = [];
let y = 70;
const put = (tex, size, paint, display) => {
  const r = typeset(font, 'lmm', tex, { size, display });
  if (r.tag === 'Err') throw new Error(`${tex}: ${JSON.stringify(r.error)}`); // bug: a showcase formula
  y += r.value.ascent;
  items.push(...placeMath(r.value, translate((W - r.value.width) / 2, y), paint));
  y += r.value.descent;
};
put('\\text{Math in glyph: LaTeX} \\to \\text{OpenType MATH} \\to \\text{Scene}', 44, INK, false);
y += 50;
for (const [title, formulas] of SECTIONS) {
  put(`\\text{${title}}`, 26, RUST, false);
  y += 26;
  for (const tex of formulas) { put(tex, 52, INK, true); y += 34; }
  y += 36;
}
put('\\text{Latin Modern Math 1.959 (GUST e-foundry). Pure JS, zero runtime dependencies.}', 20, GREY, false);
y += 50;

const scene = draw.scene(W, Math.ceil(y), [251, 247, 239, 255], items);
writeFileSync(out, new Uint8Array(await new Response(draw.png(scene)).arrayBuffer()));
console.log(`${out}  ${W}×${Math.ceil(y)}  ${items.length} items`);
