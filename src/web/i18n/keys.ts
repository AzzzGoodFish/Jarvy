import type { en } from "./en";

/** Every key of the reference dictionary. */
export type Key = keyof typeof en;
/** A string, or a plural pair chosen by `count` (Intl.PluralRules). */
export type Entry = string | { one: string; other: string };
/** The keys the other languages must cover, in the same shape. A key that is not here, or a form the reference does
 * not have, fails the type check; the English text itself never leaks into the type. */
export type Shape = {
  [K in Key]: "one" extends keyof typeof en[K] ? { one: string; other: string } : string;
};
