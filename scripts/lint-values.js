// Errors-as-values lint for library source (not tests, examples or tools). Fails the build on:
//   ?.          optional chaining manufactures `undefined`; use an explicit check or an Option
//   undefined   in code or in a JSDoc type, outside the one allowed boundary (adt.js `option`,
//               which turns a nullable JS value into an Option) and lines marked `// edge:`
//   throw       unless the line says why it is not bad input: `// bug:` (a programming error,
//               e.g. a non-exhaustive match) or `// rethrow:` (passing a caller's exception through)
// `??` is allowed: it removes `undefined` at an input edge (an omitted option) rather than producing it.
//
//   node scripts/lint-values.js            exit 1 with file:line for each violation
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname;
const DIRS = ['sfnt/src', 'woff2/src', 'shape/src', 'outline/src', 'render/src', 'draw/src', 'spec/src', 'math/src', 'worker/src', 'cache/src', 'net/src', 'otel-compact/src'];
const FILES = [...DIRS.flatMap((d) => readdirSync(ROOT + d).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`)), 'index.js'];
// The only place `undefined` may appear: the Option boundary.
const ALLOW_UNDEFINED = new Set(['otel-compact/src/adt.js:option']);
// Inputs typed by the platform, not by us (process.env is Record<string, string | undefined>).
const PLATFORM_TYPES = /Record<string, string \| undefined>/;

const out = [];
for (const f of FILES) {
  const lines = readFileSync(ROOT + f, 'utf8').split('\n');
  let inBlock = false;
  lines.forEach((raw, i) => {
    const at = `${f}:${i + 1}`;
    const t = raw.trim();
    // Prose comments may say the word; JSDoc tag lines are types and are checked.
    const blockStart = t.startsWith('/*');
    if (blockStart) inBlock = !t.includes('*/');
    const isComment = t.startsWith('//') || ((inBlock || blockStart || t.startsWith('*')) && !/@(param|returns?|type|typedef|property|template)\b/.test(t));
    if (inBlock && t.includes('*/')) inBlock = false;
    const code = isComment ? '' : raw.replace(/\/\/ .*$/, '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    // JSDoc tag lines are checked whole (they are types); code lines with string literals blanked.
    const typeLine = isComment ? '' : /@(param|returns?|type|typedef|property|template)\b/.test(t) ? raw : code;
    if (/\?\.(?!\d)/.test(code)) out.push(`${at}  ?. manufactures undefined: ${t}`);
    if (/\bundefined\b/.test(typeLine) && !raw.includes('// edge:') && !PLATFORM_TYPES.test(raw)) {
      const fn = /export const (\w+)/.exec(raw);
      const prevFn = /export const (\w+)/.exec(lines[i + 1] || '');
      const name = fn ? fn[1] : prevFn ? prevFn[1] : '';
      if (!ALLOW_UNDEFINED.has(`${f}:${name}`)) out.push(`${at}  undefined: ${t}`);
    }
    if (/\bthrow\b/.test(code) && !/\/\/ (bug|rethrow):/.test(raw)) out.push(`${at}  throw without // bug: or // rethrow: ${t}`);
  });
}
if (out.length) { console.error(`lint-values: ${out.length} violation(s)\n  ${out.join('\n  ')}`); process.exit(1); }
console.log(`lint-values: ${FILES.length} files clean (no ?., no stray undefined, every throw annotated)`);
