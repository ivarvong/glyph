// @ts-check
// A TeX math subset → AST. Recursive descent over the source string; every node carries the
// offset it came from, and every failure is a typed TexError with that offset. Unknown control
// sequences are errors, not skipped: a formula either means what it says or does not render.
//
// The AST is TeX's math list (TeXbook ch. 17), lightly structured: atoms with a class and a
// nucleus, scripts attached to a base, and the generalized constructions (fractions, radicals,
// \left…\right, accents, matrices) as their own nodes. Characters are resolved to Unicode here
// (math alphabets included), so layout only maps code points to glyphs.

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import {
  SYMBOLS, NEGATED, BIG_OPS, FUNCTIONS, GREEK, ALPHABETS, styled, CHAR_CLASS, CHAR_MAP, DELIMS, DELIM_SYMBOLS,
  ACCENTS, BRACES, SPACES, BIG_SIZES, ENVIRONMENTS,
} from './symbols.js';

/** @typedef {import('./symbols.js').Cls} Cls */
/** @typedef {import('./symbols.js').Variant} Variant */

export const TexError = variants('TexError', {
  UnknownCommand: ['name', 'at'],
  UnknownEnvironment: ['name', 'at'],
  Unexpected: ['found', 'expected', 'at'],
  DoubleScript: ['script', 'at'],
  MissingArgument: ['name', 'at'],
  BadDelimiter: ['found', 'at'],
  TooDeep: ['limit', 'at'],
  TooLong: ['length', 'limit'],
});
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof TexError>} TexErrorT */

/** @typedef {'auto' | 'limits' | 'nolimits'} Limits */
/** @typedef {'D' | 'T' | 'S' | 'SS'} Style */
/**
 * @typedef {{ kind: 'sym', cp: number, cls: Cls, at: number }
 *   | { kind: 'row', items: Node[], at: number }
 *   | { kind: 'scripts', base: Node, sup: Node | null, sub: Node | null, at: number }
 *   | { kind: 'bigop', cp: number, limits: Limits, at: number }
 *   | { kind: 'opname', name: string, limits: Limits, at: number }
 *   | { kind: 'frac', num: Node, den: Node, bar: boolean, style: 'auto' | 'D' | 'T', open: number, close: number, at: number }
 *   | { kind: 'sqrt', body: Node, index: Node | null, at: number }
 *   | { kind: 'fenced', open: number, close: number, middles: number[], parts: Node[], at: number }
 *   | { kind: 'big', cp: number, em: number, cls: Cls, at: number }
 *   | { kind: 'accent', base: Node, cp: number, stretchy: boolean, at: number }
 *   | { kind: 'line', base: Node, under: boolean, at: number }
 *   | { kind: 'brace', base: Node, cp: number, under: boolean, at: number }
 *   | { kind: 'stack', base: Node, over: Node | null, under: Node | null, cls: Cls, at: number }
 *   | { kind: 'class', cls: Cls, body: Node, at: number }
 *   | { kind: 'text', text: string, at: number }
 *   | { kind: 'space', mu: number, at: number }
 *   | { kind: 'style', style: Style, at: number }
 *   | { kind: 'matrix', rows: Node[][], open: number, close: number, cases: boolean, small: boolean, at: number }} Node
 */

/** depth counts groups and atoms nested in each other (a {group} is two levels). */
export const TEX_LIMITS = Object.freeze({ chars: 4096, depth: 64 });

/**
 * @param {string} src @param {{ chars: number, depth: number }} [limits]
 * @returns {import('../../otel-compact/src/adt.js').Result<Node, TexErrorT>}  the whole formula as a row
 */
export function parseTex(src, limits = TEX_LIMITS) {
  if (src.length > limits.chars) return err(TexError.TooLong(src.length, limits.chars));
  let i = 0, depth = 0;
  // A sticky fault, as in the Brotli decoder: the first error is kept, the cursor jumps to the
  // end, and every loop below stops there. No exceptions, and the first error is the one reported.
  /** @type {TexErrorT | null} */
  let fault = null;
  /** @returns {Node} */
  const fail = (/** @type {TexErrorT} */ e) => { if (!fault) fault = e; i = src.length; return { kind: 'row', items: [], at: i }; };
  const isLetter = (/** @type {string} */ c) => /^[A-Za-z]$/.test(c);
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== '%') return;
      while (i < src.length && src[i] !== '\n') i++;
    }
  };
  /** The control sequence at i (after '\'), without consuming. */
  const peekCmd = () => {
    if (src[i] !== '\\') return '';
    let j = i + 1;
    if (j < src.length && isLetter(src[j])) { while (j < src.length && isLetter(src[j])) j++; return src.slice(i + 1, j); }
    return j < src.length ? src[j] : '';
  };
  const readCmd = () => {
    const name = peekCmd();
    if (!name) { fail(TexError.Unexpected('end of input', 'a control sequence name', i)); return ''; }
    i += 1 + name.length;
    return name;
  };
  const enter = () => { if (++depth > limits.depth) fail(TexError.TooDeep(limits.depth, i)); };
  /** A row of items until a stop: '}' or end, or one of the given commands, or '&', '\\'. */
  const row = (/** @type {Variant} */ v, /** @type {string[]} */ stops = []) => {
    enter();
    const at = i;
    /** @type {Node[]} */
    const items = [];
    for (;;) {
      skip();
      if (i >= src.length || src[i] === '}' || src[i] === '&' || (src[i] === ']' && stops.includes(']'))) break;
      const c = peekCmd();
      if (src[i] === '\\' && (stops.includes(c) || c === '\\' || c === 'end' || c === 'right' || c === 'middle')) break;
      if (src[i] === '^' || src[i] === '_' || src[i] === "'") { attach(items, v); continue; }
      if (c === 'limits' || c === 'nolimits') {
        i += 1 + c.length;
        const last = items[items.length - 1];
        const op = last && last.kind === 'scripts' ? last.base : last;
        if (!op || (op.kind !== 'bigop' && op.kind !== 'opname')) { fail(TexError.Unexpected(`\\${c}`, 'a large operator before \\limits or \\nolimits', i)); continue; }
        op.limits = c;
        continue;
      }
      items.push(atom(v));
    }
    depth--;
    return /** @type {Node} */ ({ kind: 'row', items, at });
  };
  /** Superscript rows made of primes, still open to one ^ (x'^2 is legal; x^2' and x'^a^b are not). */
  const primed = new WeakSet();
  /** ^ _ ' on the last item (an empty base when there is none). @param {Node[]} items @param {Variant} v */
  const attach = (items, v) => {
    const at = i, ch = src[i++];
    const last = items.pop() || /** @type {Node} */ ({ kind: 'row', items: [], at });
    /** @type {Extract<Node, { kind: 'scripts' }>} */
    const s = last.kind === 'scripts' ? last : { kind: 'scripts', base: last, sup: null, sub: null, at: last.at };
    items.push(s);
    if (ch === "'") {
      // Primes are a superscript ′ (TeXbook p. 130), several in one row.
      if (s.sup && !primed.has(s.sup)) { fail(TexError.DoubleScript('superscript', at)); return; }
      /** @type {Node[]} */
      const primes = s.sup && s.sup.kind === 'row' ? s.sup.items : [];
      primes.push({ kind: 'sym', cp: 0x2032, cls: 'ord', at });
      while (src[i] === "'") primes.push({ kind: 'sym', cp: 0x2032, cls: 'ord', at: i++ });
      if (!s.sup) { s.sup = { kind: 'row', items: primes, at }; primed.add(s.sup); }
      return;
    }
    const which = ch === '^' ? 'sup' : 'sub';
    const arg = argument(v, ch);
    const cur = s[which];
    if (cur && which === 'sup' && primed.has(cur) && cur.kind === 'row') { primed.delete(cur); cur.items.push(arg); return; }
    if (cur) { fail(TexError.DoubleScript(which === 'sup' ? 'superscript' : 'subscript', at)); return; }
    s[which] = arg;
  };
  /** One argument: a {group} or a single token (with a command's own arguments). @param {Variant} v @param {string} name */
  const argument = (v, name) => {
    skip();
    if (i >= src.length || src[i] === '}' || src[i] === '&') return fail(TexError.MissingArgument(name, i));
    if (src[i] === '^' || src[i] === '_') return fail(TexError.Unexpected(src[i], `an argument for ${name}`, i));
    return atom(v);
  };
  /** A {group}, required. @param {Variant} v @param {string} name */
  const group = (v, name) => {
    skip();
    if (src[i] !== '{') return fail(TexError.MissingArgument(name, i));
    i++;
    const r = row(v);
    close('}');
    return r;
  };
  const close = (/** @type {string} */ ch) => {
    skip();
    if (src[i] !== ch) fail(TexError.Unexpected(i < src.length ? src[i] : 'end of input', `'${ch}'`, i));
    i++;
  };
  /** Raw text of a {group} (for \text, \operatorname, \begin): braces must balance. @param {string} name */
  const rawGroup = (name) => {
    skip();
    if (src[i] !== '{') { fail(TexError.MissingArgument(name, i)); return ''; }
    const start = ++i;
    let level = 1;
    while (i < src.length && level > 0) {
      if (src[i] === '\\' && i + 1 < src.length) { i += 2; continue; }
      if (src[i] === '{') level++; else if (src[i] === '}') level--;
      i++;
    }
    if (level) { fail(TexError.Unexpected('end of input', "'}'", i)); return ''; }
    return src.slice(start, i - 1);
  };
  /** A delimiter after \left \right \middle \big…: a character or a delimiter command. */
  const delim = () => {
    skip();
    const at = i;
    if (i >= src.length) { fail(TexError.BadDelimiter('end of input', at)); return 0; }
    const key = src[i] === '\\' ? `\\${readCmd()}` : String.fromCodePoint(/** @type {number} */ (src.codePointAt(i)));
    if (key[0] !== '\\') i += key.length;
    if (!has(DELIMS, key)) { fail(TexError.BadDelimiter(key, at)); return 0; }
    return DELIMS[key];
  };
  /** @param {Variant} v @returns {Node} */
  const atom = (v) => {
    enter();
    const n = fault || i >= src.length ? fail(TexError.Unexpected('end of input', 'a math atom', i)) : atom1(v);
    depth--;
    return n;
  };
  /** @param {Variant} v @returns {Node} */
  const atom1 = (v) => {
    skip();
    const at = i;
    const ch = src[i];
    if (ch === '{') { i++; const r = row(v); close('}'); return r; }
    if (ch === '\\') return command(v);
    if (ch === '}' || ch === '&') return fail(TexError.Unexpected(ch, 'a math atom', at));
    if (ch === '#' || ch === '$') return fail(TexError.Unexpected(ch, `a math character (escape it as \\${ch})`, at));
    if (ch === '~') { i++; return { kind: 'space', mu: SPACES[' '], at }; }
    const cp = /** @type {number} */ (src.codePointAt(i));
    i += cp > 0xffff ? 2 : 1;
    const s = String.fromCodePoint(cp);
    const cls = CHAR_CLASS[s] ?? classOf(cp);
    const mapped = CHAR_MAP[s] ?? cp;
    return { kind: 'sym', cp: cls === 'ord' ? styled(mapped, v) : mapped, cls, at };
  };
  /** @param {Variant} v @returns {Node} */
  const command = (v) => {
    const at = i;
    const name = readCmd();
    if (has(GREEK, name)) return { kind: 'sym', cp: styled(GREEK[name], v), cls: 'ord', at };
    if (has(SYMBOLS, name)) {
      const [cp, cls] = SYMBOLS[name];
      // TeX pads \iff, \implies, \impliedby with \; (amsmath: \DOTSB\;\Longleftrightarrow\;).
      if (name === 'iff' || name === 'implies' || name === 'impliedby') {
        return { kind: 'row', items: [{ kind: 'space', mu: 5, at }, { kind: 'sym', cp, cls, at }, { kind: 'space', mu: 5, at }], at };
      }
      return { kind: 'sym', cp, cls, at };
    }
    if (has(DELIM_SYMBOLS, name)) { const [cp, cls] = DELIM_SYMBOLS[name]; return { kind: 'sym', cp, cls, at }; }
    if (has(BIG_OPS, name)) { const [cp, limits] = BIG_OPS[name]; return { kind: 'bigop', cp, limits, at }; }
    if (has(FUNCTIONS, name)) return { kind: 'opname', name, limits: FUNCTIONS[name] ? 'auto' : 'nolimits', at };
    if (has(SPACES, name)) return { kind: 'space', mu: SPACES[name], at };
    if (has(ALPHABETS, name)) { const g = argument(ALPHABETS[name], `\\${name}`); return g.kind === 'row' ? g : { kind: 'row', items: [g], at }; }
    if (has(ACCENTS, name)) { const [cp, stretchy] = ACCENTS[name]; return { kind: 'accent', base: argument(v, `\\${name}`), cp, stretchy, at }; }
    if (has(BRACES, name)) { const [cp, under] = BRACES[name]; return { kind: 'brace', base: argument(v, `\\${name}`), cp, under, at }; }
    if (has(BIG_SIZES, name)) { const [em, cls] = BIG_SIZES[name]; return { kind: 'big', cp: delim(), em, cls, at }; }
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': {
        const num = argument(v, `\\${name}`), den = argument(v, `\\${name}`);
        return { kind: 'frac', num, den, bar: true, style: name === 'dfrac' || name === 'cfrac' ? 'D' : name === 'tfrac' ? 'T' : 'auto', open: 0, close: 0, at };
      }
      case 'binom': case 'dbinom': case 'tbinom': {
        const num = argument(v, `\\${name}`), den = argument(v, `\\${name}`);
        return { kind: 'frac', num, den, bar: false, style: name === 'dbinom' ? 'D' : name === 'tbinom' ? 'T' : 'auto', open: 0x28, close: 0x29, at };
      }
      case 'sqrt': {
        skip();
        let index = null;
        if (src[i] === '[') { i++; index = row(v, [']']); close(']'); }
        return { kind: 'sqrt', body: argument(v, '\\sqrt'), index, at };
      }
      case 'left': {
        const open = delim();
        /** @type {Node[]} */
        const parts = [];
        /** @type {number[]} */
        const middles = [];
        for (;;) {
          parts.push(row(v));
          skip();
          const c = peekCmd();
          if (c === 'middle') { readCmd(); middles.push(delim()); continue; }
          if (c === 'right') { readCmd(); return { kind: 'fenced', open, close: delim(), middles, parts, at }; }
          return fail(TexError.Unexpected(i < src.length ? src.slice(i, i + 8) : 'end of input', '\\right to close \\left', i));
        }
      }
      case 'right': case 'middle': return fail(TexError.Unexpected(`\\${name}`, 'a \\left before it', at));
      case 'overline': case 'underline': return { kind: 'line', base: argument(v, `\\${name}`), under: name === 'underline', at };
      case 'overset': case 'underset': case 'stackrel': {
        const script = argument(v, `\\${name}`), base = argument(v, `\\${name}`);
        return { kind: 'stack', base, over: name === 'underset' ? null : script, under: name === 'underset' ? script : null, cls: name === 'stackrel' ? 'rel' : clsOf(base), at };
      }
      case 'text': case 'textrm': case 'mbox': case 'textup': case 'textnormal':
        return { kind: 'text', text: rawGroup(`\\${name}`).replace(/(^|[^\\])[{}]/g, '$1').replace(/\\([{}$&#%_ ])/g, '$1'), at };
      case 'operatorname': {
        const star = src[i] === '*';
        if (star) i++;
        const text = rawGroup('\\operatorname');
        if (/\\/.test(text)) return fail(TexError.Unexpected(text, 'plain letters in \\operatorname', at));
        return { kind: 'opname', name: text.trim(), limits: star ? 'auto' : 'nolimits', at };
      }
      case 'mathord': case 'mathop': case 'mathbin': case 'mathrel': case 'mathopen': case 'mathclose': case 'mathpunct': case 'mathinner': {
        const cls = /** @type {Cls} */ (name.slice(4));
        return { kind: 'class', cls, body: argument(v, `\\${name}`), at };
      }
      case 'displaystyle': return { kind: 'style', style: 'D', at };
      case 'textstyle': return { kind: 'style', style: 'T', at };
      case 'scriptstyle': return { kind: 'style', style: 'S', at };
      case 'scriptscriptstyle': return { kind: 'style', style: 'SS', at };
      case 'not': {
        const next = atom(v);
        const neg = next.kind === 'sym' ? NEGATED[next.cp] : 0;
        if (!neg) return fail(TexError.Unexpected(src.slice(at, i), 'a relation \\not can negate (=, <, \\in, \\equiv, …)', at));
        return { kind: 'sym', cp: neg, cls: 'rel', at };
      }
      case 'begin': {
        const env = rawGroup('\\begin');
        if (!has(ENVIRONMENTS, env)) return fail(TexError.UnknownEnvironment(env, at));
        const [open, closeCp] = ENVIRONMENTS[env];
        /** @type {Node[][]} */
        const rows = [[]];
        for (;;) {
          rows[rows.length - 1].push(row(v));
          skip();
          if (src[i] === '&') { i++; continue; }
          const c = peekCmd();
          if (c === '\\') { i += 2; rows.push([]); continue; }
          if (c === 'end') {
            readCmd();
            const end = rawGroup('\\end');
            if (end !== env) return fail(TexError.Unexpected(`\\end{${end}}`, `\\end{${env}}`, i));
            const last = rows[rows.length - 1];
            if (rows.length > 1 && last.length === 1 && last[0].kind === 'row' && last[0].items.length === 0) rows.pop(); // a trailing \\
            return { kind: 'matrix', rows, open, close: closeCp, cases: env === 'cases', small: env === 'smallmatrix', at };
          }
          return fail(TexError.Unexpected(i < src.length ? src[i] : 'end of input', `& or \\\\ or \\end{${env}}`, i));
        }
      }
      default: return fail(TexError.UnknownCommand(`\\${name}`, at));
    }
  };
  const r = row('default');
  skip();
  if (i < src.length) fail(TexError.Unexpected(src[i] === '\\' ? `\\${peekCmd()}` : src[i], 'end of input', i));
  return fault ? err(fault) : ok(r);
}

const has = (/** @type {object} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);

/** The class of a node used as a base (\stackrel{…}{=} is a relation; \overset keeps the base's). @param {Node} n @returns {Cls} */
function clsOf(n) {
  if (n.kind === 'sym') return n.cls;
  if (n.kind === 'row' && n.items.length === 1) return clsOf(n.items[0]);
  return n.kind === 'bigop' || n.kind === 'opname' ? 'op' : 'ord';
}

/** @type {Map<number, Cls>} */
const BY_CP = new Map();
for (const [cp, cls] of Object.values(SYMBOLS)) if (!BY_CP.has(cp)) BY_CP.set(cp, cls);
/** A character typed directly (≤, →, ∑…): the class its command has. @param {number} cp @returns {Cls} */
const classOf = (cp) => BY_CP.get(cp) ?? 'ord';
