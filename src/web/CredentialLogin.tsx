import { useEffect, useRef, useState } from "react";
import { api, type ModelConnection, type CredentialState } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";

export function CredentialLogin({ connection, providerName, authType, ensureConnection, onChanged }: {
  connection?: ModelConnection; providerName: string; authType: ModelConnection["authType"];
  ensureConnection: () => Promise<string>; onChanged: () => Promise<void>;
}) {
  const [state, setState] = useState<CredentialState>({ phase: "idle" });
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const initialChoice = useRef<string | undefined>(undefined);
  const connectionId = connection?.id;
  const changed = useRef(onChanged); changed.current = onChanged;
  const phase = useRef(state.phase); phase.current = state.phase;
  useEffect(() => {
    if (!connectionId) return;
    const id = connectionId;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        let next = await api.authStatus(id);
        if (!alive) return;
        if (initialChoice.current && next.prompt?.type === "select") {
          const choice = initialChoice.current; initialChoice.current = undefined;
          next = await api.authInput(id, next.prompt.id, choice);
          if (!alive) return;
        }
        const finished = phase.current === "running" && next.phase !== "running";
        phase.current = next.phase; setState(next);
        if (finished) await changed.current();
        if (next.phase === "running" && alive) timer = setTimeout(() => void read(), 750);
      } catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : "读取授权状态失败"); }
    }
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [connectionId, state.phase, refresh]);
  useEffect(() => setValue(""), [state.prompt?.id]);
  async function act(action: () => Promise<CredentialState>) {
    setBusy(true); setError("");
    try { const next = await action(); setState(next); if (next.phase !== "running") await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试。"); }
    finally { setBusy(false); }
  }
  function start(choice?: string) {
    initialChoice.current = choice;
    void act(async () => {
      const id = connectionId ?? await ensureConnection();
      return api.authStart(id);
    });
  }
  const codex = providerName === "openai-codex" && authType === "oauth";
  const directChatGpt = providerName === "openai" && authType === "oauth";
  const running = state.phase === "running", prompt = state.prompt, event = state.event;
  const link = event?.type === "auth_url" ? event.url : event?.type === "device_code" ? event.verificationUri : null;
  const submit = (input: string) => { if (prompt && connectionId) void act(() => api.authInput(connectionId, prompt.id, input)); };
  return <section className="jv-auth" aria-label="账户授权">
    <div className="jv-auth-header"><h3>账户授权</h3><Badge variant="outline" data-state={running ? "running" : connection?.configured ? "connected" : "disconnected"}>{running ? "授权中" : connection?.configured ? authType === "oauth" ? "已登录" : "已配置" : authType === "oauth" ? "未登录" : "未配置"}</Badge></div>
    {running ? <div className="jv-auth-flow">
      {link && <Button asChild variant="outline"><a style={{ color: "inherit", textDecoration: "none" }} href={link} target="_blank" rel="noopener noreferrer">打开授权页面</a></Button>}
      {event?.type === "device_code" && <p>验证码：<code className="select-all font-mono">{event.userCode}</code></p>}
      {prompt?.type === "select" && <div className="flex flex-wrap gap-2">{prompt.options?.map(option => <Button type="button" variant="outline" key={option.id} disabled={busy} onClick={() => submit(option.id)}>
        {codex && option.id === "browser" ? "浏览器登录（OAuth）" : codex && option.id === "device_code" ? "设备码登录" : option.label}
      </Button>)}</div>}
      {prompt && prompt.type !== "select" && <div className="jv-auth-input">
        <Label htmlFor={`oauth-input-${connectionId ?? providerName}`}>{prompt.type === "manual_code" ? directChatGpt ? "完整回调地址" : "授权码或回调地址" : prompt.message}</Label>
        {prompt.type === "manual_code" && <p className="jv-auth-note">完成授权后若未自动返回，请粘贴回调地址。</p>}
        <Input id={`oauth-input-${connectionId ?? providerName}`} type={prompt.type === "text" ? "text" : "password"} autoComplete="off" value={value} disabled={busy}
          onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); submit(value); } }}/>
        <Button type="button" variant="outline" disabled={busy || !value.trim()} onClick={() => submit(value)}>继续</Button>
      </div>}
      {!prompt && <p role="status" className="text-sm text-muted-foreground">等待授权完成…</p>}
      {event?.type === "info" && <p className="text-sm">{event.message}</p>}
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void act(() => api.authCancel(connectionId!))}>取消授权</Button>
    </div> : <div className="flex flex-wrap gap-2">
      {codex ? <>
        <Button type="button" variant="outline" disabled={busy} onClick={() => start("browser")}>浏览器登录（OAuth）</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => start("device_code")}>设备码登录</Button>
      </> : <Button type="button" variant="outline" disabled={busy} onClick={() => start()}>{authType === "api_key" ? "配置凭证" : connection?.configured ? "重新登录" : "登录账户"}</Button>}
      {connection?.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => void act(async () => { await api.authLogout(connectionId!); return { phase: "idle" }; })}>{authType === "api_key" ? "移除凭证" : "退出登录"}</Button>}
    </div>}
    {(error || state.error) && <p role="alert" className="jarvy-model-feedback">{error || state.error}</p>}
    {error && <Button type="button" variant="link" disabled={busy} onClick={() => { setError(""); setRefresh(value => value + 1); }}>刷新状态</Button>}
  </section>;
}
