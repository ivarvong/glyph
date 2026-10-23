// Interface for adt.js, in the spirit of an OCaml .mli: the runtime stays
// plain JS, the types live here. TypeScript resolves `./adt.js` to this file.

export type Spec = Record<string, readonly string[]>;
type Tags<S extends Spec> = keyof S & string;

export type Variant<S extends Spec, K extends Tags<S>> =
  { readonly tag: K } & { readonly [F in S[K][number]]: any };

/** The sum type of a declared ADT value: `Of<typeof Config>`. */
export type Of<A> = A extends ADT<infer S> ? Union<S> : never;

/** The sum type: one of the variants of S. */
export type Union<S extends Spec> = { [K in Tags<S>]: Variant<S, K> }[Tags<S>];

/** Homomorphic over a generic tuple, so arity is preserved: ['a','b'] -> [any, any]. */
type Args<T extends readonly unknown[]> = { -readonly [I in keyof T]: any };

type Ctor<S extends Spec, K extends Tags<S>> = S[K] extends readonly []
  ? Variant<S, K>
  : (...args: Args<S[K]>) => Variant<S, K>;

/** Every case required: a missing variant is a type error, as in OCaml. */
export type Cases<S extends Spec, R> = { [K in Tags<S>]: (v: Variant<S, K>) => R };
export type Wild<S extends Spec, R> = Partial<Cases<S, R>> & { _: (v: Union<S>) => R };

/** No keys beyond the variant tags (and `_`): a misspelled case is a type error. */
type NoExtra<S extends Spec, C> = C & { [K in Exclude<keyof C, Tags<S> | '_'>]: never };

/** Union of what the provided cases return (OCaml unifies branch types; TS unions them). */
type Out<C> = { [K in keyof C]: C[K] extends (...a: any[]) => infer R ? R : never }[keyof C];

export type ADT<S extends Spec> = { readonly [K in Tags<S>]: Ctor<S, K> } & {
  match<C extends Cases<S, unknown>>(v: Union<S>, cases: NoExtra<S, C>): Out<C>;
  match<C extends Wild<S, unknown>>(v: Union<S>, cases: NoExtra<S, C>): Out<C>;
  is(v: unknown): v is Union<S>;
  readonly tags: readonly Tags<S>[];
  readonly name: string;
};

/** Variant names are checked at runtime against match/is/tags/name; field "tag" is reserved. */
export function variants<const S extends Spec>(name: string, spec: S): ADT<S>;

export type Ok<T> = { readonly tag: 'Ok'; readonly value: T };
export type Err<E> = { readonly tag: 'Err'; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T>;
export function err<E>(error: E): Err<E>;
export function andThen<T, U, E>(r: Result<T, E>, f: (t: T) => Result<U, E>): Result<U, E>;
export function map<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E>;
export function unwrap<T, E>(r: Result<T, E>): T;

export type Some<T> = { readonly tag: 'Some'; readonly value: T };
export type None = { readonly tag: 'None' };
/** Absence as a value: `None` is one frozen, branded object. Nothing returns undefined. */
export type Option<T> = Some<T> | None;
export function some<T>(value: T): Some<T>;
export const NONE: None;
export function option<T>(v: T | undefined | null): Option<T>;
export function getOr<T>(o: Option<T>, fallback: T): T;
export function mapOption<T, U>(o: Option<T>, f: (t: T) => U): Option<U>;
export function okOr<T, E>(o: Option<T>, error: E): Result<T, E>;
