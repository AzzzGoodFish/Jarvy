import { useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { applyTheme, Icon } from "./ui";

export function Login({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (loading) return;
    setLoading(true); setError("");
    try {
      const result = await api.login(username.trim(), password);
      setPassword(""); onLogin(result.username);
    } catch (reason) {
      setError(reason instanceof ApiError && reason.status === 401 ? "账号或密码不正确。" : reason instanceof ApiError && reason.status === 429 ? "尝试次数较多，请稍后再试。" : "暂时无法登录，请检查连接后重试。");
    } finally { setLoading(false); }
  }
  return <div className="jv-login">
    <button className="jv-login-theme" type="button" onClick={() => { const next = dark ? "light" : "dark"; applyTheme(next); setDark(!dark); }} aria-label={dark ? "切换为浅色主题" : "切换为深色主题"}>
      <Icon name={dark ? "sun" : "moon"}/>
    </button>
    <main className="jv-login-stage"><div className="jv-login-wrap">
      <header className="jv-login-brand"><img className="jv-login-logo" src="/icon.svg" alt="" width={64} height={64}/><h1>Jarvy</h1><p>登录以继续</p></header>
      <form className="jv-login-form" onSubmit={event => void submit(event)} aria-label="登录" aria-busy={loading}>
        <div className="jv-login-field"><label htmlFor="login-username">用户名</label>
          <input id="login-username" autoComplete="username" autoFocus required disabled={loading} value={username} onChange={event => setUsername(event.target.value)}/></div>
        <div className="jv-login-field"><label htmlFor="login-password">密码</label><div className="jv-login-password">
          <input id="login-password" type={visible ? "text" : "password"} autoComplete="current-password" required disabled={loading} value={password} onChange={event => setPassword(event.target.value)}/>
          <button type="button" className="jv-login-visibility" aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}><Icon name={visible ? "eye-slash" : "eye"}/></button>
        </div></div>
        {error && <p className="jv-login-error" role="alert">{error}</p>}
        <button className="jv-login-submit" type="submit" disabled={loading}>{loading ? "正在登录…" : "登录"}</button>
      </form>
    </div></main>
  </div>;
}
