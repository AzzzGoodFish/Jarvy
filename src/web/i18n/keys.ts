import type { en } from "./en";

/** Every key of the reference dictionary. */
export type Key = keyof typeof en;
/** A string, or a plural pair chosen by `count` (Intl.PluralRules). */
export type Entry = string | { one: string; other: string };
/** Another language's version of an English part: the same keys in the same shape. A key that is not there, or a form
 * the reference does not have, fails the type check; the English text itself never leaks into the type. */
export type Part<T> = { [K in keyof T]: "one" extends keyof T[K] ? { one: string; other: string } : string };
/** A whole dictionary: every key of the reference. */
export type Shape = Part<typeof en>;
