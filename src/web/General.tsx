import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { LOCALES, getLocale, localeLabel, setLocale, t } from "./i18n";
import { applyTheme } from "./ui";

/** Settings → General: the interface language (each named in itself, so it can be found from either) and the theme,
 * both remembered in this browser. The account menu's theme switch stays as a shortcut. */
export function General() {
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  const theme = (next: boolean) => { applyTheme(next ? "dark" : "light"); setDark(next); };
  const option = (key: string, label: string, on: boolean, pick: () => void, lang?: string) => <button key={key} type="button" role="radio" aria-checked={on} lang={lang}
    className="jv-list-row jv-choice-row" onClick={pick}><span className="jv-row-text"><strong>{label}</strong></span>{on && <CheckIcon aria-hidden="true"/>}</button>;
  return <div className="jv-page">
    <header className="jv-page-header"><div><h2>{t("settings.general")}</h2></div></header>
    <section className="jv-section" aria-labelledby="general-language"><h3 id="general-language" className="jv-section-title">{t("general.language")}</h3>
      <div className="jv-list" role="radiogroup" aria-labelledby="general-language">
        {LOCALES.map(locale => option(locale, localeLabel(locale, "name"), getLocale() === locale, () => setLocale(locale), locale))}</div></section>
    <section className="jv-section" aria-labelledby="general-theme"><h3 id="general-theme" className="jv-section-title">{t("general.theme")}</h3>
      <div className="jv-list" role="radiogroup" aria-labelledby="general-theme">
        {option("light", t("general.light"), !dark, () => theme(false))}{option("dark", t("general.dark"), dark, () => theme(true))}</div></section>
  </div>;
}
