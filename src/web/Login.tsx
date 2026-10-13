import { useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { applyTheme, Icon } from "./ui";
import { LOCALES, getLocale, localeLabel, setLocale, t } from "./i18n";
import type { Key } from "./i18n/keys";

export function Login({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  // A key, not text: switching the language here re-renders the message too.
  const [error, setError] = useState<Key | null>(null);
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (loading) return;
    setLoading(true); setError(null);
    try {
      const result = await api.login(username.trim(), password);
      setPassword(""); onLogin(result.username);
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 401 ? "login.wrong" : reason instanceof ApiError && reason.status === 429 ? "login.tooMany" : "login.offline");
    } finally { setLoading(false); }
  }
  return <div className="jv-login">
    <div className="jv-login-corner">
      {/* The same choice as Settings → General; each language named in itself. */}
      <div className="jv-login-locales" role="group" aria-label={t("general.language")}>
        {LOCALES.map(locale => <button key={locale} type="button" lang={locale} aria-pressed={getLocale() === locale} title={localeLabel(locale, "name")}
          onClick={() => setLocale(locale)}>{localeLabel(locale, "short")}</button>)}
      </div>
      <button className="jv-login-theme" type="button" onClick={() => { const next = dark ? "light" : "dark"; applyTheme(next); setDark(!dark); }} aria-label={t(dark ? "login.themeLight" : "login.themeDark")}>
        <Icon name={dark ? "sun" : "moon"}/>
      </button>
    </div>
    <main className="jv-login-stage"><div className="jv-login-wrap">
      <header className="jv-login-brand"><img className="jv-login-logo" src="/icon.svg" alt="" width={64} height={64}/><h1>Jarvy</h1><p>{t("login.subtitle")}</p></header>
      <form className="jv-login-form" onSubmit={event => void submit(event)} aria-label={t("login.form")} aria-busy={loading}>
        <div className="jv-login-field"><label htmlFor="login-username">{t("login.username")}</label>
          <input id="login-username" autoComplete="username" autoFocus required disabled={loading} value={username} onChange={event => setUsername(event.target.value)}/></div>
        <div className="jv-login-field"><label htmlFor="login-password">{t("login.password")}</label><div className="jv-login-password">
          <input id="login-password" type={visible ? "text" : "password"} autoComplete="current-password" required disabled={loading} value={password} onChange={event => setPassword(event.target.value)}/>
          <button type="button" className="jv-login-visibility" aria-label={t(visible ? "login.hidePassword" : "login.showPassword")} onClick={() => setVisible(!visible)}><Icon name={visible ? "eye-slash" : "eye"}/></button>
        </div></div>
        {error && <p className="jv-login-error" role="alert">{t(error)}</p>}
        <button className="jv-login-submit" type="submit" disabled={loading}>{t(loading ? "login.submitting" : "login.submit")}</button>
      </form>
    </div></main>
  </div>;
}
