// @ts-check
// TeX control sequences → Unicode code points and TeX atom classes (TeXbook ch. 17, App. B and F;
// codepoints as unicode-math assigns them, so a formula typesets with any OpenType math font).
// Every code point here is checked against Latin Modern Math's cmap by math/test/tex.test.js.

/** TeX atom classes (TeXbook p. 158). @typedef {'ord' | 'op' | 'bin' | 'rel' | 'open' | 'close' | 'punct' | 'inner'} Cls */

/** @type {Record<string, [number, Cls]>} */
export const SYMBOLS = {};
/** @param {Cls} cls @param {Record<string, number>} m */
const add = (cls, m) => { for (const [k, cp] of Object.entries(m)) SYMBOLS[k] = [cp, cls]; };

add('ord', {
  infty: 0x221e, partial: 0x1d715, nabla: 0x2207, forall: 0x2200, exists: 0x2203, nexists: 0x2204, neg: 0xac, lnot: 0xac,
  emptyset: 0x2205, varnothing: 0x2300, hbar: 0x210f, hslash: 0x210f, ell: 0x2113, wp: 0x2118, Re: 0x211c, Im: 0x2111,
  aleph: 0x2135, beth: 0x2136, angle: 0x2220, triangle: 0x25b3, prime: 0x2032, top: 0x22a4, bot: 0x22a5, surd: 0x221a,
  flat: 0x266d, natural: 0x266e, sharp: 0x266f, clubsuit: 0x2663, diamondsuit: 0x2662, heartsuit: 0x2661, spadesuit: 0x2660,
  imath: 0x1d6a4, jmath: 0x1d6a5, Box: 0x25a1, vdots: 0x22ee, backslash: 0x5c, '%': 0x25, '#': 0x23,
  '&': 0x26, $: 0x24, _: 0x5f, '|': 0x2016, vert: 0x7c, Vert: 0x2016, mho: 0x2127, complement: 0x2201, checkmark: 0x2713,
  dagger: 0x2020, ddagger: 0x2021, S: 0xa7, P: 0xb6,
});
add('inner', { ldots: 0x2026, dots: 0x2026, cdots: 0x22ef, ddots: 0x22f1 });
add('bin', {
  pm: 0xb1, mp: 0x2213, times: 0xd7, div: 0xf7, cdot: 0x22c5, ast: 0x2217, star: 0x22c6, circ: 0x2218, bullet: 0x2219,
  cap: 0x2229, cup: 0x222a, uplus: 0x228e, sqcap: 0x2293, sqcup: 0x2294, vee: 0x2228, lor: 0x2228, wedge: 0x2227, land: 0x2227,
  setminus: 0x2216, wr: 0x2240, oplus: 0x2295, ominus: 0x2296, otimes: 0x2297, oslash: 0x2298, odot: 0x2299, amalg: 0x2a3f,
  diamond: 0x22c4, bigtriangleup: 0x25b3, bigtriangledown: 0x25bd, triangleleft: 0x25c1, triangleright: 0x25b7,
  lhd: 0x22b2, rhd: 0x22b3, unlhd: 0x22b4, unrhd: 0x22b5, bigcirc: 0x25ef, cdotp: 0x22c5,
});
add('rel', {
  le: 0x2264, leq: 0x2264, ge: 0x2265, geq: 0x2265, ne: 0x2260, neq: 0x2260, equiv: 0x2261, sim: 0x223c, simeq: 0x2243,
  approx: 0x2248, cong: 0x2245, asymp: 0x224d, propto: 0x221d, subset: 0x2282, supset: 0x2283, subseteq: 0x2286,
  supseteq: 0x2287, subsetneq: 0x228a, supsetneq: 0x228b, sqsubset: 0x228f, sqsupset: 0x2290, sqsubseteq: 0x2291,
  sqsupseteq: 0x2292, in: 0x2208, ni: 0x220b, owns: 0x220b, notin: 0x2209, vdash: 0x22a2, dashv: 0x22a3, models: 0x22a8,
  perp: 0x27c2, mid: 0x2223, nmid: 0x2224, parallel: 0x2225, nparallel: 0x2226, prec: 0x227a, succ: 0x227b,
  preceq: 0x2aaf, succeq: 0x2ab0, ll: 0x226a, gg: 0x226b, bowtie: 0x22c8, smile: 0x2323, frown: 0x2322, doteq: 0x2250,
  coloneqq: 0x2254, leqslant: 0x2a7d, geqslant: 0x2a7e, lesssim: 0x2272, gtrsim: 0x2273, triangleq: 0x225c,
  leftarrow: 0x2190, gets: 0x2190, rightarrow: 0x2192, to: 0x2192, uparrow: 0x2191, downarrow: 0x2193,
  leftrightarrow: 0x2194, updownarrow: 0x2195, Leftarrow: 0x21d0, Rightarrow: 0x21d2, Uparrow: 0x21d1, Downarrow: 0x21d3,
  Leftrightarrow: 0x21d4, Updownarrow: 0x21d5, mapsto: 0x21a6, longleftarrow: 0x27f5, longrightarrow: 0x27f6,
  longleftrightarrow: 0x27f7, Longleftarrow: 0x27f8, Longrightarrow: 0x27f9, Longleftrightarrow: 0x27fa,
  longmapsto: 0x27fc, hookleftarrow: 0x21a9, hookrightarrow: 0x21aa, leftharpoonup: 0x21bc, leftharpoondown: 0x21bd,
  rightharpoonup: 0x21c0, rightharpoondown: 0x21c1, rightleftharpoons: 0x21cc, nearrow: 0x2197, searrow: 0x2198,
  swarrow: 0x2199, nwarrow: 0x2196, leadsto: 0x21dd, iff: 0x27fa, implies: 0x27f9, impliedby: 0x27f8,
});
add('punct', { colon: 0x3a });
add('open', { '{': 0x7b, lbrace: 0x7b });
add('close', { '}': 0x7d, rbrace: 0x7d });

/** `\not` applied to a relation: TeX overstrikes a slash; Unicode has precomposed forms. */
export const NEGATED = /** @type {Record<number, number>} */ ({
  0x3d: 0x2260, 0x3c: 0x226e, 0x3e: 0x226f, 0x2264: 0x2270, 0x2265: 0x2271, 0x2208: 0x2209, 0x220b: 0x220c,
  0x2261: 0x2262, 0x223c: 0x2241, 0x2243: 0x2244, 0x2248: 0x2249, 0x2245: 0x2247, 0x2282: 0x2284, 0x2283: 0x2285,
  0x2286: 0x2288, 0x2287: 0x2289, 0x2223: 0x2224, 0x2225: 0x2226, 0x227a: 0x2280, 0x227b: 0x2281,
});

/** Large operators: [cp, limits]. `\int` and kin are \nolimits by default (plain.tex: \def\int{\intop\nolimits}). @type {Record<string, [number, 'auto' | 'nolimits']>} */
export const BIG_OPS = {
  sum: [0x2211, 'auto'], prod: [0x220f, 'auto'], coprod: [0x2210, 'auto'], bigcup: [0x22c3, 'auto'], bigcap: [0x22c2, 'auto'],
  bigvee: [0x22c1, 'auto'], bigwedge: [0x22c0, 'auto'], bigoplus: [0x2a01, 'auto'], bigotimes: [0x2a02, 'auto'],
  bigodot: [0x2a00, 'auto'], biguplus: [0x2a04, 'auto'], bigsqcup: [0x2a06, 'auto'],
  int: [0x222b, 'nolimits'], iint: [0x222c, 'nolimits'], iiint: [0x222d, 'nolimits'], oint: [0x222e, 'nolimits'],
  oiint: [0x222f, 'nolimits'], oiiint: [0x2230, 'nolimits'],
};

/** Function names set in roman as Op atoms (TeXbook p. 162); `true`: limits in display style. @type {Record<string, boolean>} */
export const FUNCTIONS = {
  arccos: false, arcsin: false, arctan: false, arg: false, cos: false, cosh: false, cot: false, coth: false, csc: false,
  deg: false, det: true, dim: false, exp: false, gcd: true, hom: false, inf: true, ker: false, lg: false, lim: true,
  liminf: true, limsup: true, ln: false, log: false, max: true, min: true, Pr: true, sec: false, sin: false, sinh: false,
  sup: true, tan: false, tanh: false,
};

/** Greek: lowercase is math italic by default, uppercase upright (TeX's convention, unicode-math math-style=TeX). */
const GREEK_LOWER = ['alpha', 'beta', 'gamma', 'delta', 'varepsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu',
  'nu', 'xi', 'omicron', 'pi', 'rho', 'varsigma', 'sigma', 'tau', 'upsilon', 'varphi', 'chi', 'psi', 'omega'];
const GREEK_UPPER = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu',
  'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'varTheta', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'];
/** TeX's \epsilon \vartheta \varkappa \phi \varrho \varpi: the six symbol variants after ∂ in each math Greek alphabet. */
const GREEK_SYMBOLS = ['epsilon', 'vartheta', 'varkappa', 'phi', 'varrho', 'varpi'];

/** Greek name → upright Unicode code point. @type {Record<string, number>} */
export const GREEK = {};
// U+03A2 (index 17) is unassigned: ϴ takes its slot, as in the math alphabets.
GREEK_UPPER.forEach((n, i) => { GREEK[n] = n === 'varTheta' ? 0x3f4 : 0x391 + i; });
GREEK_LOWER.forEach((n, i) => { GREEK[n] = 0x3b1 + i; });
[0x3f5, 0x3d1, 0x3f0, 0x3d5, 0x3f1, 0x3d6].forEach((cp, i) => { GREEK[GREEK_SYMBOLS[i]] = cp; });

/** @typedef {'default' | 'normal' | 'italic' | 'bold' | 'bold-italic' | 'double-struck' | 'script' | 'fraktur' | 'sans-serif' | 'monospace'} Variant */
export const ALPHABETS = /** @type {Record<string, Variant>} */ ({
  mathrm: 'normal', mathit: 'italic', mathbf: 'bold', boldsymbol: 'bold-italic', bm: 'bold-italic', mathbb: 'double-struck',
  mathcal: 'script', mathscr: 'script', mathfrak: 'fraktur', mathsf: 'sans-serif', mathtt: 'monospace',
});

// Mathematical Alphanumeric Symbols (Unicode §22.2): the start of A–Z (a–z follow at +26), and the
// letters that live in Letterlike Symbols instead (the "holes").
const LATIN = /** @type {Record<string, number>} */ ({
  bold: 0x1d400, italic: 0x1d434, 'bold-italic': 0x1d468, script: 0x1d49c, fraktur: 0x1d504, 'double-struck': 0x1d538,
  'sans-serif': 0x1d5a0, monospace: 0x1d670,
});
const HOLES = /** @type {Record<string, Record<string, number>>} */ ({
  italic: { h: 0x210e },
  script: { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b, e: 0x212f, g: 0x210a, o: 0x2134 },
  fraktur: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 },
  'double-struck': { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 },
});
const DIGITS = /** @type {Record<string, number>} */ ({ bold: 0x1d7ce, 'double-struck': 0x1d7d8, 'sans-serif': 0x1d7e2, monospace: 0x1d7f6 });
// Greek alphabets: Α–Ω (25, with ϴ after Ρ), ∇, α–ω (25, with ς), ∂, ϵ ϑ ϰ ϕ ϱ ϖ.
const GREEK_BASE = /** @type {Record<string, number>} */ ({ bold: 0x1d6a8, italic: 0x1d6e2, 'bold-italic': 0x1d71c });
const GREEK_ORDER = [...Array.from({ length: 17 }, (_, i) => 0x391 + i), 0x3f4, ...Array.from({ length: 7 }, (_, i) => 0x3a3 + i),
  0x2207, ...Array.from({ length: 25 }, (_, i) => 0x3b1 + i), 0x2202, 0x3f5, 0x3d1, 0x3f0, 0x3d5, 0x3f1, 0x3d6];

/**
 * A character in a math alphabet. 'default' is TeX's: Latin letters and lowercase Greek italic,
 * digits and uppercase Greek upright. Characters an alphabet lacks are returned unchanged.
 * @param {number} cp @param {Variant} v
 */
export function styled(cp, v) {
  const ch = String.fromCodePoint(cp);
  const latin = /^[A-Za-z]$/.test(ch), digit = /^[0-9]$/.test(ch), greek = GREEK_ORDER.indexOf(cp);
  const isLowerGreek = greek >= 26 && greek <= 50;
  const w = v === 'default' ? (latin || isLowerGreek || (greek >= 51 && cp !== 0x2202) ? 'italic' : 'normal') : v;
  if (w === 'normal') return cp;
  if (latin) {
    const hole = HOLES[w] && HOLES[w][ch];
    if (hole) return hole;
    const base = LATIN[w];
    return base ? base + (ch >= 'a' ? 26 + cp - 0x61 : cp - 0x41) : cp;
  }
  if (digit) return DIGITS[w] ? DIGITS[w] + cp - 0x30 : cp;
  if (greek >= 0 && GREEK_BASE[w]) return GREEK_BASE[w] + greek;
  return cp;
}

/** Plain characters in math mode: their atom class (TeXbook App. B, plain.tex \mathcode). @type {Record<string, Cls>} */
export const CHAR_CLASS = {
  '+': 'bin', '-': 'bin', '*': 'bin', '=': 'rel', '<': 'rel', '>': 'rel', ':': 'rel', ',': 'punct', ';': 'punct',
  '(': 'open', '[': 'open', ')': 'close', ']': 'close', '!': 'close', '?': 'close',
};
/** ASCII that math mode replaces: hyphen → minus, * → asterisk operator. @type {Record<string, number>} */
export const CHAR_MAP = { '-': 0x2212, '*': 0x2217 };

/** Delimiters after \left \right \middle \big…: name or character → code point (0: the null delimiter "."). @type {Record<string, number>} */
export const DELIMS = {
  '(': 0x28, ')': 0x29, '[': 0x5b, ']': 0x5d, '|': 0x7c, '/': 0x2f, '.': 0, '<': 0x27e8, '>': 0x27e9,
  '\\{': 0x7b, '\\}': 0x7d, '\\lbrace': 0x7b, '\\rbrace': 0x7d, '\\|': 0x2016, '\\Vert': 0x2016, '\\vert': 0x7c,
  '\\lvert': 0x7c, '\\rvert': 0x7c, '\\lVert': 0x2016, '\\rVert': 0x2016, '\\langle': 0x27e8, '\\rangle': 0x27e9,
  '\\lfloor': 0x230a, '\\rfloor': 0x230b, '\\lceil': 0x2308, '\\rceil': 0x2309, '\\backslash': 0x5c,
  '\\uparrow': 0x2191, '\\downarrow': 0x2193, '\\updownarrow': 0x2195, '\\Uparrow': 0x21d1, '\\Downarrow': 0x21d3,
  '\\Updownarrow': 0x21d5, '\\lbrack': 0x5b, '\\rbrack': 0x5d, '\\lgroup': 0x27ee, '\\rgroup': 0x27ef,
};
/** Delimiter commands that are also plain symbols outside \left…\right. @type {Record<string, [number, Cls]>} */
export const DELIM_SYMBOLS = {
  langle: [0x27e8, 'open'], rangle: [0x27e9, 'close'], lfloor: [0x230a, 'open'], rfloor: [0x230b, 'close'],
  lceil: [0x2308, 'open'], rceil: [0x2309, 'close'], lvert: [0x7c, 'open'], rvert: [0x7c, 'close'],
  lVert: [0x2016, 'open'], rVert: [0x2016, 'close'], lbrack: [0x5b, 'open'], rbrack: [0x5d, 'close'],
};

/** Accents: [code point, stretchy (wide)]. Combining marks, as unicode-math and MathML set them. @type {Record<string, [number, boolean]>} */
export const ACCENTS = {
  hat: [0x302, false], check: [0x30c, false], tilde: [0x303, false], acute: [0x301, false], grave: [0x300, false],
  dot: [0x307, false], ddot: [0x308, false], breve: [0x306, false], bar: [0x304, false], vec: [0x20d7, false],
  mathring: [0x30a, false], widehat: [0x302, true], widetilde: [0x303, true], widecheck: [0x30c, true],
  overrightarrow: [0x2192, true], overleftarrow: [0x2190, true], overleftrightarrow: [0x2194, true],
};
/** Under/over braces: stretchy horizontal constructions with a limit-style script. @type {Record<string, [number, boolean]>} */
export const BRACES = { overbrace: [0x23de, false], underbrace: [0x23df, true] };

/** Math spacing in mu (18 mu = 1 em; TeXbook p. 168). `\ ` and `~` are an interword space, ≈ 6 mu in cmr10. @type {Record<string, number>} */
export const SPACES = { ',': 3, thinspace: 3, ':': 4, '>': 4, medspace: 4, ';': 5, thickspace: 5, '!': -3, negthinspace: -3,
  quad: 18, qquad: 36, ' ': 6, enspace: 9 };

/** \big…\Bigg heights in em (plain.tex: 8.5pt, 11.5pt, 14.5pt, 17.5pt at 10pt). */
export const BIG_SIZES = /** @type {Record<string, [number, Cls]>} */ ({});
for (const [k, em] of /** @type {[string, number][]} */ ([['big', 0.85], ['Big', 1.15], ['bigg', 1.45], ['Bigg', 1.75]])) {
  BIG_SIZES[k] = [em, 'ord']; BIG_SIZES[`${k}l`] = [em, 'open']; BIG_SIZES[`${k}r`] = [em, 'close']; BIG_SIZES[`${k}m`] = [em, 'rel'];
}

/** Matrix-like environments: their fences (0: none). @type {Record<string, [number, number]>} */
export const ENVIRONMENTS = {
  matrix: [0, 0], pmatrix: [0x28, 0x29], bmatrix: [0x5b, 0x5d], Bmatrix: [0x7b, 0x7d], vmatrix: [0x7c, 0x7c],
  Vmatrix: [0x2016, 0x2016], cases: [0x7b, 0], smallmatrix: [0, 0],
};
