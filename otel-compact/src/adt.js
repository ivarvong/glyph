// @ts-check
// Tagged unions with arity-checked constructors and exhaustive match.
// OCaml gives you exhaustiveness at compile time; we get it at every call
// (runtime) plus at check time via the JSDoc types each module declares.

/**
 * @template {Record<string, readonly string[]>} S
 * @param {string} name
 * @param {S} spec  variant tag -> field names (empty array = nullary)
 */
export function variants(name, spec) {
  const tags = Object.freeze(Object.keys(spec));
  for (const t of tags) {
    if (t === 'match' || t === 'is' || t === 'tags' || t === 'name') {
      throw new TypeError(`${name}: variant name "${t}" is reserved`); // bug: misuse of the ADT API
    }
  }
  /** @type {Record<string, any>} */
  const ctors = {};
  for (const tag of tags) {
    const fields = spec[tag];
    // A field called `tag` would overwrite the discriminant and make the value
    // impersonate another variant. Found by fuzzing; rejected at definition.
    if (fields.includes('tag')) throw new TypeError(`${name}.${tag}: field name "tag" is reserved`); // bug: misuse of the ADT API
    if (new Set(fields).size !== fields.length) throw new TypeError(`${name}.${tag}: duplicate field names`); // bug: misuse of the ADT API
    if (fields.length === 0) {
      ctors[tag] = Object.freeze({ tag });
      continue;
    }
    ctors[tag] = (/** @type {any[]} */ ...args) => {
      if (args.length !== fields.length) {
        throw new TypeError(`${name}.${tag}: expected ${fields.length} args (${fields.join(', ')}), got ${args.length}`); // bug: misuse of the ADT API
      }
      /** @type {Record<string, unknown>} */
      const o = { tag };
      for (let i = 0; i < fields.length; i++) o[fields[i]] = args[i];
      return Object.freeze(o);
    };
  }

  /**
   * Exhaustive match: every tag must have a case unless `_` is given.
   * Checked on every call, so a newly added variant fails loudly at the
   * first match site that forgot it, not silently at the value that hits it.
   * @param {{tag: string}} v
   * @param {Record<string, (v: any) => any>} cases
   */
  const match = (v, cases) => {
    if (!('_' in cases)) {
      for (const t of tags) {
        if (!(t in cases)) throw new TypeError(`${name}.match: missing case ${t}`); // bug: misuse of the ADT API
      }
    }
    for (const k in cases) {
      if (k !== '_' && !tags.includes(k)) throw new TypeError(`${name}.match: unknown case ${k}`); // bug: misuse of the ADT API
    }
    const f = (v !== null && typeof v === 'object' && cases[v.tag]) || cases._;
    if (!f) throw new TypeError(`${name}.match: not a ${name}: ${JSON.stringify(v)}`); // bug: misuse of the ADT API
    return f(v);
  };

  const is = (/** @type {unknown} */ v) =>
    typeof v === 'object' && v !== null && tags.includes(/** @type {any} */ (v).tag);

  return Object.freeze({ ...ctors, match, is, tags, name });
}

// Result: the one ADT everything returns at a boundary. No exceptions cross it.
/** @template T @typedef {{ readonly tag: 'Ok', readonly value: T }} Ok */
/** @template E @typedef {{ readonly tag: 'Err', readonly error: E }} Err */
/** @template T, E @typedef {Ok<T> | Err<E>} Result */

/** @template T @param {T} value @returns {Ok<T>} */
export const ok = (value) => Object.freeze({ tag: 'Ok', value });
/** @template E @param {E} error @returns {Err<E>} */
export const err = (error) => Object.freeze({ tag: 'Err', error });

/**
 * @template T, U, E
 * @param {Result<T, E>} r
 * @param {(t: T) => Result<U, E>} f
 * @returns {Result<U, E>}
 */
export const andThen = (r, f) => (r.tag === 'Ok' ? f(r.value) : r);

/**
 * @template T, U, E
 * @param {Result<T, E>} r
 * @param {(t: T) => U} f
 * @returns {Result<U, E>}
 */
export const map = (r, f) => (r.tag === 'Ok' ? ok(f(r.value)) : r);

/**
 * Unwrap or throw: for tests and top-level scripts only.
 * @template T, E @param {Result<T, E>} r @returns {T}
 */
export const unwrap = (r) => {
  if (r.tag === 'Ok') return r.value;
  throw new Error(`unwrap Err: ${JSON.stringify(r.error)}`); // bug: unwrap asserts Ok
};

// Option: the one way to say "absent". `None` is a single frozen, branded value; no API returns
// undefined or null. Use it where a value may legitimately be missing (cache lookups, map gets);
// use Result where absence is an error.
/** @template T @typedef {{ readonly tag: 'Some', readonly value: T }} Some */
/** @typedef {{ readonly tag: 'None' }} None */
/** @template T @typedef {Some<T> | None} Option */

/** @template T @param {T} value @returns {Some<T>} */
export const some = (value) => Object.freeze({ tag: 'Some', value });
/** @type {None} */
export const NONE = Object.freeze({ tag: 'None' });
/** From a nullable JS value (Map.get, array index) to an Option: the only place undefined is touched. @template T @param {T | undefined | null} v @returns {Option<T>} */
export const option = (v) => (v === undefined || v === null ? NONE : some(v));
/** @template T @param {Option<T>} o @param {T} fallback @returns {T} */
export const getOr = (o, fallback) => (o.tag === 'Some' ? o.value : fallback);
/** @template T, U @param {Option<T>} o @param {(t: T) => U} f @returns {Option<U>} */
export const mapOption = (o, f) => (o.tag === 'Some' ? some(f(o.value)) : NONE);
/** @template T, E @param {Option<T>} o @param {E} error @returns {Result<T, E>} */
export const okOr = (o, error) => (o.tag === 'Some' ? ok(o.value) : err(error));
