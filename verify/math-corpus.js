// Math corpus for the Chromium differential (verify/math.js): each formula as LaTeX (what glyph
// typesets) and as hand-written MathML Core (what Chromium lays out with the same font). The
// MathML is written the way a careful author or a TeX-to-MathML converter would, not generated
// from glyph's parser, so the two sides share nothing but the font.
//
// Conventions, each chosen so the MathML says what the TeX says:
// - letters as explicit math-italic code points (𝑥, U+1D465). Plain <mi>x</mi> is equivalent by
//   MathML's math-auto transform, but Chromium then reports (and lays out with) the ink box of the
//   upright x: AUTO_ITALIC=1 writes <mi>x</mi> to show it.
// - one <mn> per digit: TeX sets each digit as its own atom.
// - TeX's plain ( ) [ ] | are not stretchy; only \left \right \middle \big are. So plain ones are
//   <mo stretchy="false">, as Temml and MathJax write them (the operator dictionary would make them stretchy).
// - \overbrace's brace is full size and stretched in TeX: stretchy="true" and math-depth: add(0)
//   (an overscript is otherwise one script level down, and Chromium did not stretch U+23DE).
// - data-skip: a token with no TeX counterpart: \overline's glyph (TeX draws a rule), U+2061.

const AUTO = typeof process !== 'undefined' && process.env.AUTO_ITALIC === '1';
const italic = (c) => (/[a-z]/.test(c) ? (c === 'h' ? '\u210E' : String.fromCodePoint(0x1d44e + c.charCodeAt(0) - 97))
  : /[A-Z]/.test(c) ? String.fromCodePoint(0x1d434 + c.charCodeAt(0) - 65) : c);
const mi = (s) => s.split('').map((c) => `<mi>${AUTO ? c : italic(c)}</mi>`).join('');
const fence = (c) => `<mo stretchy="false">${c}</mo>`;
const mn = (s) => s.split('').map((c) => `<mn>${c}</mn>`).join('');
const mo = (s) => `<mo>${s}</mo>`;
const row = (...xs) => `<mrow>${xs.join('')}</mrow>`;
const frac = (a, b) => `<mfrac>${a}${b}</mfrac>`;
const sup = (a, b) => `<msup>${a}${b}</msup>`;
const sub = (a, b) => `<msub>${a}${b}</msub>`;
const subsup = (a, b, c) => `<msubsup>${a}${b}${c}</msubsup>`;
const under = (a, b) => `<munder>${a}${b}</munder>`;
const underover = (a, b, c) => `<munderover>${a}${b}${c}</munderover>`;
const sqrt = (...xs) => `<msqrt>${xs.join('')}</msqrt>`;
const space = (em) => `<mspace width="${em}em"/>`;
const ital = { alpha: '\u{1D6FC}', beta: '\u{1D6FD}', gamma: '\u{1D6FE}', pi: '\u{1D70B}', rho: '\u{1D70C}', epsilon: '\u{1D716}', varepsilon: '\u{1D700}',
  mu: '\u{1D707}', theta: '\u{1D703}', varphi: '\u{1D711}', partial: '\u{1D715}', gammaI: '\u{1D6FE}' };
const G = (k) => `<mi>${ital[k]}</mi>`;
const up = (c) => `<mi mathvariant="normal">${c}</mi>`;
const AF = '<mo data-skip="apply-function">&#x2061;</mo>';
const INF = '<mi>&#x221E;</mi>';
const acc = (base, cp, stretchy = false) => `<mover accent="true">${base}<mo${stretchy ? '' : ' stretchy="false"'}>&#x${cp};</mo></mover>`;
const bold = (c) => `<mi>${String.fromCodePoint(0x1d400 + (c >= 'a' ? 26 + c.charCodeAt(0) - 97 : c.charCodeAt(0) - 65))}</mi>`;

/** @type {{ id: string, tex: string, display: boolean, mml: string }[]} */
export const CORPUS = [
  { id: 'quadratic', display: true, tex: 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}',
    mml: mi('x') + mo('=') + frac(row(mo('&#x2212;'), mi('b'), mo('&#xB1;'), sqrt(sup(mi('b'), mn('2')), mo('&#x2212;'), mn('4'), mi('ac'))), row(mn('2'), mi('a'))) },
  { id: 'euler', display: false, tex: 'e^{i\\pi} + 1 = 0', mml: sup(mi('e'), row(mi('i'), G('pi'))) + mo('+') + mn('1') + mo('=') + mn('0') },
  { id: 'gaussian', display: true, tex: '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
    mml: subsup(mo('&#x222B;'), row(mo('&#x2212;'), INF), INF) + sup(mi('e'), row(mo('&#x2212;'), sup(mi('x'), mn('2')))) + space(0.1667) + mi('dx') + mo('=') + sqrt(G('pi')) },
  { id: 'cauchy', display: true, tex: 'f(a) = \\frac{1}{2\\pi i}\\oint_\\gamma \\frac{f(z)}{z-a}\\,dz',
    mml: mi('f') + fence('(') + mi('a') + fence(')') + mo('=') + frac(mn('1'), row(mn('2'), G('pi'), mi('i'))) + sub(mo('&#x222E;'), G('gamma'))
      + frac(row(mi('f'), fence('('), mi('z'), fence(')')), row(mi('z'), mo('&#x2212;'), mi('a'))) + space(0.1667) + mi('dz') },
  { id: 'maxwell-gauss', display: true, tex: '\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}',
    mml: up('&#x2207;') + mo('&#x22C5;') + bold('E') + mo('=') + frac(G('rho'), sub(G('varepsilon'), mn('0'))) },
  { id: 'maxwell-ampere', display: true, tex: '\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0\\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}',
    mml: up('&#x2207;') + mo('&#xD7;') + bold('B') + mo('=') + sub(G('mu'), mn('0')) + bold('J') + mo('+') + sub(G('mu'), mn('0')) + sub(G('varepsilon'), mn('0'))
      + frac(row(G('partial'), bold('E')), row(G('partial'), mi('t'))) },
  { id: 'binomial', display: true, tex: '\\left(x+y\\right)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^{n-k} y^k',
    mml: sup(row(mo('('), mi('x'), mo('+'), mi('y'), mo(')')), mi('n')) + mo('=') + underover(mo('&#x2211;'), row(mi('k'), mo('='), mn('0')), mi('n'))
      + row(mo('('), '<mfrac linethickness="0">' + mi('n') + mi('k') + '</mfrac>', mo(')')) + sup(mi('x'), row(mi('n'), mo('&#x2212;'), mi('k'))) + sup(mi('y'), mi('k')) },
  { id: 'scripts', display: false, tex: 'x_i^2 + y_{ij}^{k+1}', mml: subsup(mi('x'), mi('i'), mn('2')) + mo('+') + subsup(mi('y'), row(mi('ij')), row(mi('k'), mo('+'), mn('1'))) },
  { id: 'primes', display: false, tex: "f'(x) + f''(x)", mml: sup(mi('f'), mo('&#x2032;')) + fence('(') + mi('x') + fence(')') + mo('+') + sup(mi('f'), row(mo('&#x2032;'), mo('&#x2032;'))) + fence('(') + mi('x') + fence(')') },
  { id: 'nested-scripts', display: false, tex: 'a^{b^{c}} + a_{b_{c}}', mml: sup(mi('a'), sup(mi('b'), mi('c'))) + mo('+') + sub(mi('a'), sub(mi('b'), mi('c'))) },
  { id: 'deep-scripts', display: false, tex: '2^{2^{2^{2}}}', mml: sup(mn('2'), sup(mn('2'), sup(mn('2'), mn('2')))) },
  { id: 'text-fractions', display: false, tex: '\\tfrac{1}{2} + \\frac{a}{b}', mml: frac(mn('1'), mn('2')) + mo('+') + frac(mi('a'), mi('b')) },
  { id: 'dfrac', display: false, tex: 'y = \\dfrac{1}{2}', mml: mi('y') + mo('=') + `<mstyle displaystyle="true">${frac(mn('1'), mn('2'))}</mstyle>` },
  { id: 'continued', display: true, tex: '\\frac{1}{1+\\frac{1}{x}}', mml: frac(mn('1'), row(mn('1'), mo('+'), frac(mn('1'), mi('x')))) },
  { id: 'nested-sqrt', display: true, tex: '\\sqrt{1+\\sqrt{1+\\sqrt{x}}}', mml: sqrt(mn('1'), mo('+'), sqrt(mn('1'), mo('+'), sqrt(mi('x')))) },
  { id: 'cube-root', display: false, tex: '\\sqrt[3]{x^3+y^3}', mml: `<mroot>${row(sup(mi('x'), mn('3')), mo('+'), sup(mi('y'), mn('3')))}${mn('3')}</mroot>` },
  { id: 'fences', display: true, tex: '\\left[ \\frac{a}{b} \\right] \\left\\{ \\frac{c}{d} \\right\\}',
    mml: row(mo('['), frac(mi('a'), mi('b')), mo(']')) + row(mo('{'), frac(mi('c'), mi('d')), mo('}')) },
  { id: 'middle', display: false, tex: '\\left\\{ x \\in \\mathbb{R} \\middle| x > 0 \\right\\}',
    mml: row(mo('{'), mi('x'), mo('&#x2208;'), `<mi>&#x211D;</mi>`, mo('|'), mi('x'), mo('&gt;'), mn('0'), mo('}')) },
  { id: 'assembly', display: true, tex: '\\left( \\frac{\\frac{a}{b}}{\\frac{c}{d}} \\right)',
    mml: row(mo('('), frac(frac(mi('a'), mi('b')), frac(mi('c'), mi('d'))), mo(')')) },
  { id: 'sum-text', display: false, tex: '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
    mml: underover(mo('&#x2211;'), row(mi('i'), mo('='), mn('1')), mi('n')) + mi('i') + mo('=') + frac(row(mi('n'), fence('('), mi('n'), mo('+'), mn('1'), fence(')')), mn('2')) },
  { id: 'euler-product', display: true, tex: '\\prod_{p} \\frac{1}{1-p^{-s}}', mml: under(mo('&#x220F;'), mi('p')) + frac(mn('1'), row(mn('1'), mo('&#x2212;'), sup(mi('p'), row(mo('&#x2212;'), mi('s'))))) },
  { id: 'limits-nolimits', display: true, tex: '\\sum\\nolimits_{i} a_i \\quad \\int\\limits_0^1 f',
    mml: sub(mo('&#x2211;'), mi('i')) + sub(mi('a'), mi('i')) + space(1) + underover(mo('&#x222B;'), mn('0'), mn('1')) + mi('f') },
  { id: 'bigcup', display: true, tex: '\\bigcup_{n=1}^{\\infty} A_n', mml: underover(mo('&#x22C3;'), row(mi('n'), mo('='), mn('1')), INF) + sub(mi('A'), mi('n')) },
  { id: 'lim', display: true, tex: '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
    mml: under(mo('lim'), row(mi('x'), mo('&#x2192;'), mn('0'))) + frac(row(`<mi>sin</mi>`, AF, mi('x')), mi('x')) + mo('=') + mn('1') },
  { id: 'trig', display: false, tex: '\\sin^2\\theta + \\cos^2\\theta = 1', mml: sup(`<mi>sin</mi>`, mn('2')) + AF + G('theta') + mo('+') + sup(`<mi>cos</mi>`, mn('2')) + AF + G('theta') + mo('=') + mn('1') },
  { id: 'logs', display: false, tex: '\\log_2 n + \\ln x + \\exp(y)', mml: sub(`<mi>log</mi>`, mn('2')) + AF + mi('n') + mo('+') + `<mi>ln</mi>` + AF + mi('x') + mo('+') + `<mi>exp</mi>` + AF + fence('(') + mi('y') + fence(')') },
  { id: 'operatorname', display: false, tex: '\\operatorname{tr}(A) + \\det B', mml: `<mi>tr</mi>` + AF + fence('(') + mi('A') + fence(')') + mo('+') + `<mi>det</mi>` + AF + mi('B') },
  { id: 'accents', display: false, tex: '\\hat{x} + \\bar{y} + \\tilde{n} + \\dot{a} + \\ddot{b}',
    mml: acc(mi('x'), '302') + mo('+') + acc(mi('y'), '304') + mo('+') + acc(mi('n'), '303') + mo('+') + acc(mi('a'), '307') + mo('+') + acc(mi('b'), '308') },
  { id: 'vectors', display: false, tex: '\\vec{v} \\cdot \\vec{w}', mml: acc(mi('v'), '20D7') + mo('&#x22C5;') + acc(mi('w'), '20D7') },
  { id: 'wide-accents', display: false, tex: '\\widehat{xyz} + \\widetilde{abc}', mml: acc(row(mi('xyz')), '302', true) + mo('+') + acc(row(mi('abc')), '303', true) },
  { id: 'bars', display: false, tex: '\\overline{z} + \\underline{w}',
    mml: `<mover>${mi('z')}<mo data-skip="rule" stretchy="true">&#x305;</mo></mover>` + mo('+') + `<munder>${mi('w')}<mo data-skip="rule" stretchy="true">&#x332;</mo></munder>` },
  { id: 'overbrace', display: true, tex: '\\overbrace{a+\\cdots+a}^{k}', mml: `<mover><mover>${row(mi('a'), mo('+'), mo('&#x22EF;'), mo('+'), mi('a'))}<mo stretchy="true" style="math-depth: add(0)">&#x23DE;</mo></mover>${mi('k')}</mover>` },
  { id: 'text', display: false, tex: 'f(x) = 0 \\text{ if } x < 0', mml: mi('f') + fence('(') + mi('x') + fence(')') + mo('=') + mn('0') + '<mtext>&#xA0;if&#xA0;</mtext>' + mi('x') + mo('&lt;') + mn('0') },
  { id: 'greek', display: false, tex: '\\alpha\\beta\\gamma\\Gamma\\Delta\\Omega\\varphi\\epsilon',
    mml: G('alpha') + G('beta') + G('gamma') + up('&#x393;') + up('&#x394;') + up('&#x3A9;') + G('varphi') + G('epsilon') },
  { id: 'alphabets', display: false, tex: '\\mathbb{R}\\mathcal{L}\\mathfrak{g}\\mathbf{v}\\mathsf{A}\\mathtt{x}\\mathrm{d}',
    mml: '<mi>&#x211D;</mi><mi>&#x2112;</mi><mi>&#x1D524;</mi><mi>&#x1D42F;</mi><mi>&#x1D5A0;</mi><mi>&#x1D6A1;</mi>' + up('d') },
  { id: 'relations', display: false, tex: 'a \\le b \\ne c \\to d \\Rightarrow e \\subseteq f',
    mml: mi('a') + mo('&#x2264;') + mi('b') + mo('&#x2260;') + mi('c') + mo('&#x2192;') + mi('d') + mo('&#x21D2;') + mi('e') + mo('&#x2286;') + mi('f') },
  { id: 'binary', display: false, tex: 'a \\pm b \\times c \\div d \\cdot e \\cup f',
    mml: mi('a') + mo('&#xB1;') + mi('b') + mo('&#xD7;') + mi('c') + mo('&#xF7;') + mi('d') + mo('&#x22C5;') + mi('e') + mo('&#x222A;') + mi('f') },
  { id: 'spacing', display: false, tex: 'a\\,b\\:c\\;d\\!e\\quad f\\qquad g',
    mml: mi('a') + space(0.1667) + mi('b') + space(0.2222) + mi('c') + space(0.2778) + mi('d') + '<mspace width="-0.1667em"/>' + mi('e') + space(1) + mi('f') + space(2) + mi('g') },
  { id: 'big', display: false, tex: '\\Bigl( \\bigl[ x \\bigr] \\Bigr)',
    mml: '<mo minsize="1.8em" maxsize="1.8em">(</mo><mo minsize="1.2em" maxsize="1.2em">[</mo>' + mi('x') + '<mo minsize="1.2em" maxsize="1.2em">]</mo><mo minsize="1.8em" maxsize="1.8em">)</mo>' },
  { id: 'matrix', display: true, tex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    mml: row(mo('('), `<mtable><mtr><mtd>${mi('a')}</mtd><mtd>${mi('b')}</mtd></mtr><mtr><mtd>${mi('c')}</mtd><mtd>${mi('d')}</mtd></mtr></mtable>`, mo(')')) },
  { id: 'cases', display: true, tex: '|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}',
    mml: fence('|') + mi('x') + fence('|') + mo('=') + row(mo('{'), `<mtable><mtr><mtd style="text-align:left">${mi('x')}</mtd><mtd style="text-align:left">${mi('x') + mo('&#x2265;') + mn('0')}</mtd></mtr>`
      + `<mtr><mtd style="text-align:left">${mo('&#x2212;') + mi('x')}</mtd><mtd style="text-align:left">${mi('x') + mo('&lt;') + mn('0')}</mtd></mtr></mtable>`) },
  { id: 'unary', display: false, tex: '-a + (-b) = -(a+b)', mml: mo('&#x2212;') + mi('a') + mo('+') + fence('(') + mo('&#x2212;') + mi('b') + fence(')') + mo('=') + mo('&#x2212;') + fence('(') + mi('a') + mo('+') + mi('b') + fence(')') },
  { id: 'punctuation', display: false, tex: 'f(x, y) = x; y', mml: mi('f') + fence('(') + mi('x') + mo(',') + mi('y') + fence(')') + mo('=') + mi('x') + mo(';') + mi('y') },
  { id: 'integral-display', display: true, tex: '\\int_0^1 x^2\\,dx = \\frac{1}{3}', mml: subsup(mo('&#x222B;'), mn('0'), mn('1')) + sup(mi('x'), mn('2')) + space(0.1667) + mi('dx') + mo('=') + frac(mn('1'), mn('3')) },
];
