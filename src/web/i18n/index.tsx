import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import { en } from "./en";
import type { Entry, Key } from "./keys";
import { zh } from "./zh";

/** Interface languages (A45): one dictionary each, English the reference. Strings come from `t()` at render time —
 * never at module top level, so a language switch re-renders them. */
export type Locale = "en" | "zh";
export const LOCALES: readonly Locale[] = ["en", "zh"];
const dictionaries: Record<Locale, Record<Key, Entry>> = { en, zh };
/** BCP 47 tags for `<html lang>` and Intl. */
const TAGS: Record<Locale, string> = { en: "en", zh: "zh-CN" };
const STORAGE = "jarvy-locale";

/** The saved choice, else the browser's first language we have (zh* → Chinese), else English. */
function detect(): Locale {
  const saved = localStorage.getItem(STORAGE);
  if (saved === "en" || saved === "zh") return saved;
  const first = (navigator.languages?.length ? navigator.languages : [navigator.language]).map(item => item.toLowerCase()).find(item => /^(en|zh)\b/.test(item));
  return first?.startsWith("zh") ? "zh" : "en";
}
let current = detect();
document.documentElement.lang = TAGS[current];
const listeners = new Set<() => void>();

export const getLocale = () => current;
export function setLocale(next: Locale) {
  if (next === current) return;
  current = next; localStorage.setItem(STORAGE, next); document.documentElement.lang = TAGS[next];
  for (const listener of listeners) listener();
}
/** Re-renders the caller when the language changes (the app root uses it, so everything follows). */
export function useLocale() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getLocale);
}
/** A language's own name ("English", "中文") or short mark ("EN", "中"), whatever the current language is. */
export const localeLabel = (locale: Locale, form: "name" | "short") => dictionaries[locale][form === "name" ? "locale.name" : "locale.short"] as string;

function text(key: Key, count: unknown) {
  const entry = dictionaries[current][key];
  return typeof entry === "string" ? entry : new Intl.PluralRules(TAGS[current]).select(Number(count)) === "one" ? entry.one : entry.other;
}
/** The current language's text for `key`, with `{name}` filled from `vars` (`count` also picks the plural form). */
export function t(key: Key, vars?: Record<string, string | number>) {
  const value = text(key, vars?.count);
  return vars ? value.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match) : value;
}
/** Like t(), when some values are elements (a <strong> inside a sentence). */
export function rich(key: Key, vars: Record<string, ReactNode>) {
  return text(key, vars.count).split(/\{(\w+)\}/).map((part, index) => <Fragment key={index}>{index % 2 ? vars[part] ?? `{${part}}` : part}</Fragment>);
}
