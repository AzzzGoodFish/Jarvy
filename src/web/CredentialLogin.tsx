import { useEffect, useRef, useState } from "react";
import { api, type ModelConnection, type CredentialState } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { t } from "./i18n";

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
      } catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : t("auth.statusFailed")); }
    }
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [connectionId, state.phase, refresh]);
  useEffect(() => setValue(""), [state.prompt?.id]);
  async function act(action: () => Promise<CredentialState>) {
    setBusy(true); setError("");
    try { const next = await action(); setState(next); if (next.phase !== "running") await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("common.failed")); }
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
  return <section className="jv-auth" aria-label={t("auth.title")}>
    <div className="jv-auth-header"><h3>{t("auth.title")}</h3><Badge variant="outline" data-state={running ? "running" : connection?.configured ? "connected" : "disconnected"}>{t(running ? "auth.running" : connection?.configured ? authType === "oauth" ? "status.signedIn" : "status.configured" : authType === "oauth" ? "status.signedOut" : "status.notConfigured")}</Badge></div>
    {running ? <div className="jv-auth-flow">
      {link && <Button asChild variant="outline"><a style={{ color: "inherit", textDecoration: "none" }} href={link} target="_blank" rel="noopener noreferrer">{t("auth.openPage")}</a></Button>}
      {event?.type === "device_code" && <p>{t("auth.code", { code: event.userCode })}</p>}
      {prompt?.type === "select" && <div className="flex flex-wrap gap-2">{prompt.options?.map(option => <Button type="button" variant="outline" key={option.id} disabled={busy} onClick={() => submit(option.id)}>
        {codex && option.id === "browser" ? t("auth.browser") : codex && option.id === "device_code" ? t("auth.deviceCode") : option.label}
      </Button>)}</div>}
      {prompt && prompt.type !== "select" && <div className="jv-auth-input">
        <Label htmlFor={`oauth-input-${connectionId ?? providerName}`}>{prompt.type === "manual_code" ? t(directChatGpt ? "auth.redirectFull" : "auth.redirectOrCode") : prompt.message}</Label>
        {prompt.type === "manual_code" && <p className="jv-auth-note">{t("auth.manualNote")}</p>}
        <Input id={`oauth-input-${connectionId ?? providerName}`} type={prompt.type === "text" ? "text" : "password"} autoComplete="off" value={value} disabled={busy}
          onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); submit(value); } }}/>
        <Button type="button" variant="outline" disabled={busy || !value.trim()} onClick={() => submit(value)}>{t("common.continue")}</Button>
      </div>}
      {!prompt && <p role="status" className="text-sm text-muted-foreground">{t("auth.waiting")}</p>}
      {event?.type === "info" && <p className="text-sm">{event.message}</p>}
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void act(() => api.authCancel(connectionId!))}>{t("auth.cancel")}</Button>
    </div> : <div className="flex flex-wrap gap-2">
      {codex ? <>
        <Button type="button" variant="outline" disabled={busy} onClick={() => start("browser")}>{t("auth.browser")}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => start("device_code")}>{t("auth.deviceCode")}</Button>
      </> : <Button type="button" variant="outline" disabled={busy} onClick={() => start()}>{t(authType === "api_key" ? "auth.configureCredential" : connection?.configured ? "auth.signInAgain" : "auth.signIn")}</Button>}
      {connection?.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => void act(async () => { await api.authLogout(connectionId!); return { phase: "idle" }; })}>{t(authType === "api_key" ? "auth.removeCredential" : "auth.signOut")}</Button>}
    </div>}
    {(error || state.error) && <p role="alert" className="jarvy-model-feedback">{error || state.error}</p>}
    {error && <Button type="button" variant="link" disabled={busy} onClick={() => { setError(""); setRefresh(value => value + 1); }}>{t("auth.refresh")}</Button>}
  </section>;
}
