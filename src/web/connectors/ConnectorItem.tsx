import { useEffect, useState, type FormEvent } from "react";
import { ChevronDownIcon } from "lucide-react";
import { api } from "../api";
import type { Bot } from "../../contract/bots";
import type { Connector, ConnectorAuthKind, ConnectorSafety, ConnectorUse } from "../../contract/connectors";
import { formatDate, t } from "../i18n";
import { useAction } from "../action";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { BotGrants } from "../secrets/SecretGrants";
import { ConnectorMark } from "./ConnectorMark";

const when = (at: number) => formatDate(at, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function statusKey(status: Connector["status"]) {
  if (status === "connected") return "connectors.statusConnected" as const;
  if (status === "needs_auth") return "connectors.statusNeedsAuth" as const;
  if (status === "error") return "connectors.statusError" as const;
  return "connectors.statusDisconnected" as const;
}

export function safetyKey(safety: ConnectorSafety) {
  if (safety === "read_only") return "connectors.safetyReadOnly" as const;
  if (safety === "auto") return "connectors.safetyAuto" as const;
  return "connectors.safetyConfirm" as const;
}

/** One expandable connector row in Settings → Connectors (A95). */
export function ConnectorItem({ connector, bots, open, autoOAuth, onToggle, onChanged, onDeleted }: {
  connector: Connector; bots: Bot[]; open: boolean; autoOAuth?: boolean; onToggle: () => void;
  onChanged: (connector: Connector) => void; onDeleted: () => void;
}) {
  const isCustom = connector.provider === "custom_mcp";
  const isBuiltin = connector.kind === "builtin";
  const isDualAuth = connector.provider === "github" || connector.provider === "slack";
  const [uses, setUses] = useState<ConnectorUse[] | null>(null);
  const [name, setName] = useState(connector.name);
  const [url, setUrl] = useState(connector.url);
  const [authKind, setAuthKind] = useState<ConnectorAuthKind>(connector.authKind);
  const [clientId, setClientId] = useState(connector.oauthClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenValue, setTokenValue] = useState("");
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([]);
  const [waitingOAuth, setWaitingOAuth] = useState(Boolean(autoOAuth));
  const [authUrl, setAuthUrl] = useState<string | undefined>(undefined);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction<"save" | "probe" | "oauth" | "manual" | "delete">();

  useEffect(() => {
    setName(connector.name);
    setUrl(connector.url);
    setAuthKind(connector.authKind);
    setClientId(connector.oauthClientId ?? "");
  }, [connector.id, connector.name, connector.url, connector.authKind, connector.oauthClientId]);

  useEffect(() => {
    if (autoOAuth) setWaitingOAuth(true);
  }, [autoOAuth]);

  useEffect(() => {
    if (open) void api.connectorUses(connector.id).then(res => setUses(res.uses)).catch(() => setUses([]));
  }, [open, connector.id, connector.uses]);

  useEffect(() => {
    if (!waitingOAuth) return;
    const timer = window.setInterval(() => {
      void api.connectorOAuthStatus(connector.id).then(({ oauth, connector: next }) => {
        if (oauth.authUrl) setAuthUrl(oauth.authUrl);
        if (oauth.phase === "completed" || next.status === "connected" || oauth.phase === "error") {
          setWaitingOAuth(false);
          onChanged(next);
        }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [waitingOAuth, connector.id, onChanged]);

  const startOAuth = () => void run("oauth", async () => {
    if (isBuiltin && (clientId.trim() !== (connector.oauthClientId ?? "") || clientSecret.trim() || authKind !== connector.authKind)) {
      const updated = await api.updateConnector(connector.id, {
        authKind: "oauth",
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      });
      setClientSecret("");
      onChanged(updated);
    }
    const redirectUri = `${window.location.origin}/api/connectors/oauth/callback`;
    const state = await api.startConnectorOAuth(connector.id, redirectUri);
    if (state.phase === "completed") {
      onChanged((await api.connectorOAuthStatus(connector.id)).connector);
      return;
    }
    if (state.authUrl) {
      setAuthUrl(state.authUrl);
      window.open(state.authUrl, "_blank", "noopener");
      setWaitingOAuth(true);
    }
  });

  const connectToken = () => void run("save", async () => {
    const raw = tokenValue.trim();
    if (!raw) return;
    const updated = await api.updateConnector(connector.id, {
      authKind: "headers",
      headers: { Authorization: `Bearer ${raw.replace(/^Bearer\s+/i, "")}` },
    });
    setTokenValue("");
    onChanged(updated);
  });

  const completeManual = () => void run("manual", async () => {
    await api.completeConnectorOAuth(connector.id, { callbackUrl });
    setWaitingOAuth(false);
    setCallbackUrl("");
    onChanged((await api.connectorOAuthStatus(connector.id)).connector);
  });

  const saveCustom = (event: FormEvent) => {
    event.preventDefault();
    void run("save", async () => {
      const headers = headerRows.reduce<Record<string, string>>((acc, row) => {
        if (row.key.trim() && row.value) acc[row.key.trim()] = row.value;
        return acc;
      }, {});
      const updated = await api.updateConnector(connector.id, {
        name: name.trim(),
        url: url.trim(),
        authKind,
        ...(authKind === "oauth" ? { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) } : {}),
        ...(authKind === "headers" && Object.keys(headers).length ? { headers } : {}),
      });
      setClientSecret("");
      setHeaderRows([]);
      onChanged(updated);
    });
  };

  const botName = (id: string) => bots.find(bot => bot.id === id)?.name ?? t("secrets.deletedBot");
  const grantedIds = connector.grants.map(grant => grant.botId);
  const subtitle = connector.tools.length
    ? t("connectors.toolCount", { count: connector.tools.length })
    : isCustom ? connector.url : t(safetyKey(connector.safety));

  return <>
    <button type="button" className="jv-list-row jv-secret-row" aria-expanded={open} aria-controls={`connector-${connector.id}`} onClick={onToggle}>
      <ConnectorMark badge provider={connector.provider}/>
      <span className="jv-row-text">
        <strong>{connector.name}</strong>
        <span>{subtitle}</span>
      </span>
      <span className="jv-status" data-ok={connector.status === "connected" || undefined} data-busy={connector.status === "needs_auth" || undefined} data-error={connector.status === "error" || undefined}>
        {t(statusKey(connector.status))}
      </span>
      <ChevronDownIcon className="jv-row-chevron" aria-hidden="true"/>
    </button>

    {open && <div id={`connector-${connector.id}`} className="jv-list-row jv-static-row jv-secret-details jv-connector-details">
      {!waitingOAuth && !isBuiltin && connector.status !== "connected" && <div className="jv-connector-oauth-bar">
        <span className="jv-hint">{connector.statusDetail || t(statusKey(connector.status))}</span>
        {connector.authKind === "oauth" ? <Button type="button" size="sm" className="jv-primary" disabled={busy} onClick={startOAuth}>
          {t("connectors.connect")}
        </Button> : <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run("probe", async () => onChanged(await api.probeConnector(connector.id)))}>
          {t(busy ? "connectors.refreshing" : "connectors.refresh")}
        </Button>}
      </div>}

      {!waitingOAuth && isBuiltin && connector.status !== "connected" && <div className="jv-connector-oauth">
        {isDualAuth && <div className="jv-connector-setting-row">
          <span className="jv-secret-heading">{t("connectors.auth")}</span>
          <div className="jv-seg" role="radiogroup" aria-label={t("connectors.auth")}>
            {(["headers", "oauth"] as const).map(mode => (
              <button key={mode} type="button" role="radio" aria-checked={authKind === mode} disabled={busy} onClick={() => setAuthKind(mode)}>
                {t(mode === "headers" ? "connectors.authToken" : "connectors.authOAuth")}
              </button>
            ))}
          </div>
        </div>}
        {isDualAuth && authKind === "headers" ? <label className="jv-field">
          <span>{t("connectors.token")}</span>
          <div className="jv-connector-manual">
            <Input type="password" value={tokenValue} placeholder={t(connector.provider === "github" ? "connectors.tokenPlaceholderGithub" : "connectors.tokenPlaceholderSlack")}
              onChange={event => setTokenValue(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter" && tokenValue.trim()) { event.preventDefault(); connectToken(); } }}/>
            <Button type="button" size="sm" className="jv-primary" disabled={busy || !tokenValue.trim()} onClick={connectToken}>{t("connectors.connect")}</Button>
          </div>
        </label> : <>
          <div className="jv-field-grid">
            <label className="jv-field"><span>{t("connectors.oauthClientId")}</span>
              <Input value={clientId} onChange={event => setClientId(event.target.value)}/></label>
            <label className="jv-field"><span>{t("connectors.oauthClientSecret")}</span>
              <Input type="password" value={clientSecret} placeholder={connector.hasClientSecret ? "••••••••" : ""} onChange={event => setClientSecret(event.target.value)}/></label>
          </div>
          <div className="jv-secret-actions">
            <Button type="button" size="sm" className="jv-primary" disabled={busy || !clientId.trim() || (!clientSecret.trim() && !connector.hasClientSecret)} onClick={startOAuth}>
              {t("connectors.connect")}
            </Button>
          </div>
        </>}
      </div>}

      {waitingOAuth && <div className="jv-connector-oauth">
        <div className="jv-connector-oauth-bar">
          <span>{t("connectors.waiting")}</span>
          {authUrl && <Button type="button" size="sm" variant="outline" onClick={() => window.open(authUrl, "_blank", "noopener")}>{t("connectors.reopen")}</Button>}
        </div>
        <details className="jv-advanced">
          <summary><ChevronDownIcon/>{t("connectors.pasteCallback")}</summary>
          <div className="jv-connector-manual">
            <Input value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} placeholder={t("connectors.pastePlaceholder")}/>
            <Button type="button" size="sm" variant="outline" disabled={busy || !callbackUrl.trim()} onClick={completeManual}>{t("connectors.completeManual")}</Button>
          </div>
        </details>
      </div>}

      <div className="jv-connector-setting-row">
        <span className="jv-secret-heading">{t("connectors.safety")}</span>
        <div className="jv-seg" role="radiogroup" aria-label={t("connectors.safety")}>
          {(["confirm_writes", "read_only", "auto"] as const).map(mode => (
            <button key={mode} type="button" role="radio" aria-checked={connector.safety === mode} disabled={busy}
              onClick={() => { if (connector.safety !== mode) void run("save", async () => onChanged(await api.updateConnector(connector.id, { safety: mode }))); }}>
              {t(safetyKey(mode))}
            </button>
          ))}
        </div>
      </div>

      <BotGrants
        grantedIds={grantedIds}
        bots={bots}
        onGrant={async (botIds, granted) => {
          let next = connector;
          for (const botId of botIds) next = await api.grantConnector(connector.id, botId, granted);
          onChanged(next);
        }}
      />

      {connector.tools.length > 0 && <div className="jv-secret-grants">
        <div className="jv-secret-grants-head">
          <h4 className="jv-secret-heading">{t("connectors.tools")} <span>· {connector.tools.length}</span></h4>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run("probe", async () => onChanged(await api.probeConnector(connector.id)))}>
            {t(busy ? "connectors.refreshing" : "connectors.refresh")}
          </Button>
        </div>
        <div className="jv-connector-tools">
          {connector.tools.map(tool => <div key={tool.name} className="jv-connector-tool">
            <code>{tool.name}</code>
            <span className="jv-chip" data-write={tool.readOnly === false || tool.destructive ? "" : undefined}>
              {t(tool.readOnly === false || tool.destructive ? "connectors.writeTag" : "connectors.readOnlyTag")}
            </span>
            {tool.description && <span>{tool.description}</span>}
          </div>)}
        </div>
      </div>}

      {isCustom && <form className="jv-connector-form" onSubmit={saveCustom}>
        <div className="jv-field-grid">
          <label className="jv-field"><span>{t("connectors.name")}</span>
            <Input value={name} maxLength={80} onChange={event => setName(event.target.value)}/></label>
          <label className="jv-field"><span>{t("connectors.url")}</span>
            <Input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder={t("connectors.urlPlaceholder")}/></label>
        </div>
        <div className="jv-connector-setting-row">
          <span className="jv-secret-heading">{t("connectors.auth")}</span>
          <div className="jv-seg" role="radiogroup" aria-label={t("connectors.auth")}>
            {(["oauth", "headers", "none"] as const).map(kind => (
              <button key={kind} type="button" role="radio" aria-checked={authKind === kind} onClick={() => setAuthKind(kind)}>
                {t(kind === "oauth" ? "connectors.authOAuth" : kind === "headers" ? "connectors.authHeaders" : "connectors.authNone")}
              </button>
            ))}
          </div>
        </div>
        {authKind === "oauth" && <details className="jv-advanced">
          <summary><ChevronDownIcon/>{t("connectors.advancedOAuth")}</summary>
          <div className="jv-field-grid">
            <label className="jv-field"><span>{t("connectors.oauthClientId")}</span>
              <Input value={clientId} onChange={event => setClientId(event.target.value)}/></label>
            <label className="jv-field"><span>{t("connectors.oauthClientSecret")}</span>
              <Input type="password" value={clientSecret} placeholder={connector.hasClientSecret ? "••••••••" : ""} onChange={event => setClientSecret(event.target.value)}/></label>
          </div>
        </details>}
        {authKind === "headers" && <div className="jv-connector-headers">
          {connector.headerNames.length > 0 && <p className="jv-hint">{t("connectors.headersSaved", { names: connector.headerNames.join(", ") })}</p>}
          {headerRows.map((row, idx) => <div key={idx} className="jv-header-row">
            <Input className="jv-mono" placeholder={t("connectors.headerName")} value={row.key} onChange={event => setHeaderRows(list => list.map((item, i) => i === idx ? { ...item, key: event.target.value } : item))}/>
            <Input type="password" placeholder={t("connectors.headerValue")} value={row.value} onChange={event => setHeaderRows(list => list.map((item, i) => i === idx ? { ...item, value: event.target.value } : item))}/>
            <Button type="button" size="sm" variant="ghost" onClick={() => setHeaderRows(list => list.filter((_, i) => i !== idx))}>{t("common.cancel")}</Button>
          </div>)}
          <div><Button type="button" size="sm" variant="outline" onClick={() => setHeaderRows(list => [...list, { key: "Authorization", value: "" }])}>{t("connectors.addHeader")}</Button></div>
        </div>}
        <div className="jv-secret-actions"><Button type="submit" variant="outline" size="sm" disabled={busy}>{t("common.save")}</Button></div>
      </form>}

      {uses && uses.length > 0 && <div className="jv-secret-grants">
        <h4 className="jv-secret-heading">{t("connectors.uses")}</h4>
        <ul className="jv-secret-uses">
          {uses.map(use => <li key={use.id}>
            <span>{botName(use.botId)} · {use.toolName} · {when(use.at)} · {t(use.outcome === "ok" ? "connectors.useOk" : use.outcome === "denied" ? "connectors.useDenied" : "connectors.useError")}</span>
            {use.detail && <code>{use.detail}</code>}
          </li>)}
        </ul>
      </div>}

      {!confirming ? <div className="jv-secret-actions jv-secret-danger">
        <Button type="button" variant="ghost" size="sm" disabled={busy}
          onClick={() => isCustom ? setConfirming(true) : void run("delete", async () => { await api.deleteConnector(connector.id); onDeleted(); })}>
          {t(isCustom ? "connectors.delete" : "connectors.disconnect")}
        </Button>
      </div> : <div className="jv-secret-confirm" role="group" aria-label={t("connectors.deleteTitle", { name: connector.name })}>
        <strong>{t("connectors.deleteTitle", { name: connector.name })}</strong>
        <p>{t("connectors.deleteBody")}</p>
        <div className="jv-secret-actions">
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
          <Button type="button" className="jv-primary" size="sm" disabled={busy} onClick={() => void run("delete", async () => { await api.deleteConnector(connector.id); onDeleted(); })}>{t("connectors.deleteConfirm")}</Button>
        </div>
      </div>}

      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>}
  </>;
}
