import { useEffect, useId, useState, type FormEvent } from "react";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { api } from "../api";
import type { Bot } from "../../contract/bots";
import type { Connector, ConnectorAuthKind, ConnectorOAuthState, ConnectorUse } from "../../contract/connectors";
import { formatDate, t } from "../i18n";
import { useAction } from "../action";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { BotGrants } from "../secrets/SecretGrants";
import { ConnectorMark } from "./ConnectorMark";

const SEARCH_TOOL_THRESHOLD = 8;
const when = (at: number) => formatDate(at, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One configured connector row in Settings → Connectors (A102).
 * Keeps the default view calm: Bot access + any auto-approved write exceptions; tools, logs and custom MCP
 * connection fields stay tucked inside secondary collapsible disclosures. */
export function ConnectorItem({ connector, bots, open, callbackUrl, onToggle, onChanged, onDeleted }: {
  connector: Connector; bots: Bot[]; open: boolean; callbackUrl: string;
  onToggle: () => void; onChanged: (connector: Connector) => void; onDeleted: () => void;
}) {
  const detailsId = useId();
  const isCustom = connector.provider === "custom_mcp";
  const [name, setName] = useState(connector.name);
  const [url, setUrl] = useState(connector.url);
  const [authKind, setAuthKind] = useState<ConnectorAuthKind>(connector.authKind);
  const [clientId, setClientId] = useState(connector.oauthClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([]);
  const [token, setToken] = useState("");
  const [toolFilter, setToolFilter] = useState("");
  const [uses, setUses] = useState<ConnectorUse[] | null>(null);
  const [oauth, setOAuth] = useState<ConnectorOAuthState | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    setName(connector.name);
    setUrl(connector.url);
    setAuthKind(connector.authKind);
    setClientId(connector.oauthClientId ?? "");
  }, [connector.id, connector.name, connector.url, connector.authKind, connector.oauthClientId]);

  useEffect(() => {
    if (oauth?.phase !== "waiting") return;
    const timer = window.setInterval(() => {
      void api.connectorOAuthStatus(connector.id).then(res => {
        setOAuth(res.oauth);
        onChanged(res.connector);
        if (res.oauth.phase === "completed" || res.oauth.phase === "error") {
          if (res.oauth.phase === "error" && res.oauth.error) setError(res.oauth.error);
        }
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [oauth?.phase, connector.id, onChanged, setError]);

  const startOAuth = () => void run("oauth", async () => {
    const state = await api.startConnectorOAuth(connector.id, callbackUrl);
    setOAuth(state);
    if (state.authUrl) window.open(state.authUrl, "_blank", "noopener,noreferrer");
    if (state.phase === "completed") onChanged(await api.probeConnector(connector.id));
  });

  const completeManual = (event: FormEvent) => {
    event.preventDefault();
    if (!manualUrl.trim()) return;
    void run("manual", async () => {
      const state = await api.completeConnectorOAuth(connector.id, { callbackUrl: manualUrl.trim() });
      setOAuth(state);
      setManualUrl("");
      const latest = await api.connectorOAuthStatus(connector.id);
      onChanged(latest.connector);
    });
  };

  const saveToken = (event: FormEvent) => {
    event.preventDefault();
    const clean = token.trim();
    if (!clean) return;
    const value = /^Bearer\s+/i.test(clean) ? clean : `Bearer ${clean}`;
    void run("token", async () => {
      onChanged(await api.updateConnector(connector.id, { authKind: "headers", headers: { Authorization: value } }));
      setToken("");
    });
  };

  const toggleUnconfirmed = (toolName: string, nextSkip: boolean) => void run(`tool:${toolName}`, async () => {
    const next = nextSkip
      ? [...new Set([...connector.unconfirmed, toolName])]
      : connector.unconfirmed.filter(item => item !== toolName);
    onChanged(await api.updateConnector(connector.id, { unconfirmed: next }));
  });

  const saveCustom = (event: FormEvent) => {
    event.preventDefault();
    void run("save", async () => {
      const headers = headerRows.length
        ? Object.fromEntries(headerRows.filter(row => row.key.trim() && row.value).map(row => [row.key.trim(), row.value]))
        : undefined;
      onChanged(await api.updateConnector(connector.id, {
        name: name.trim(), url: url.trim(), authKind,
        ...(headers ? { headers } : {}),
        ...(authKind === "oauth" ? { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) } : {}),
      }));
      setClientSecret("");
      setHeaderRows([]);
    });
  };

  const savePreset = (event: FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanToken = token.trim();
    if (!cleanName && !cleanToken) return;
    const tokenValue = cleanToken ? (/^Bearer\s+/i.test(cleanToken) ? cleanToken : `Bearer ${cleanToken}`) : undefined;
    void run("save", async () => {
      onChanged(await api.updateConnector(connector.id, {
        ...(cleanName && cleanName !== connector.name ? { name: cleanName } : {}),
        ...(tokenValue ? { authKind: "headers", headers: { Authorization: tokenValue } } : {}),
      }));
      setToken("");
    });
  };

  const loadUses = () => {
    if (uses !== null) return;
    void api.connectorUses(connector.id).then(res => setUses(res.uses)).catch(() => setUses([]));
  };

  const botName = (botId: string) => bots.find(bot => bot.id === botId)?.name ?? t("connectors.deletedBot");
  const accountShownInName = Boolean(connector.statusDetail && connector.name.includes(connector.statusDetail));
  const subtitle = connector.status === "connected"
    ? (!accountShownInName && connector.statusDetail ? connector.statusDetail : t("connectors.toolCount", { count: connector.tools.length }))
    : connector.statusDetail || t(connector.status === "needs_auth" ? "connectors.statusNeedsAuth" : "connectors.statusError");

  const filterNeedle = toolFilter.trim().toLowerCase();
  const visibleTools = filterNeedle
    ? connector.tools.filter(tool => tool.name.toLowerCase().includes(filterNeedle) || (tool.description ?? "").toLowerCase().includes(filterNeedle))
    : connector.tools;
  const toolsSummary = connector.unconfirmed.length > 0
    ? t("connectors.toolsSummaryWithAuto", { count: connector.tools.length, auto: connector.unconfirmed.length })
    : t("connectors.toolsSummary", { count: connector.tools.length });

  return <>
    <button type="button" className="jv-list-row jv-secret-row" aria-expanded={open} aria-controls={detailsId} onClick={onToggle}>
      <span className="jv-connector-row">
        <ConnectorMark provider={connector.provider} badge/>
        <span className="jv-row-text">
          <strong>{connector.name}</strong>
          <span>{subtitle}</span>
        </span>
      </span>
      {connector.status !== "connected" && (
        <span className="jv-connector-status" data-state={connector.status}>
          {t(connector.status === "needs_auth" ? "connectors.statusNeedsAuth" : "connectors.statusError")}
        </span>
      )}
      <ChevronDownIcon className="jv-row-chevron" aria-hidden="true"/>
    </button>

    {open && <div id={detailsId} className="jv-list-row jv-static-row jv-secret-details">
      {connector.status !== "connected" && <div className="jv-connector-alert">
        <div className="jv-connector-alert-head">
          <p className="jv-connector-alert-msg">{connector.statusDetail || t("connectors.statusNeedsAuth")}</p>
          {connector.authKind === "oauth" && (!connector.managedClient || connector.managedClient.ready) && (
            <Button type="button" className="jv-primary" size="sm" disabled={busy} onClick={startOAuth}>{t("connectors.reconnect")}</Button>
          )}
        </div>
        {oauth?.phase === "waiting" && <>
          <div className="jv-connector-drawer-row">
            <span className="jv-connector-waiting"><span className="jv-connector-waiting-dot"/>{t("connectors.oauthWaiting")}</span>
            {oauth.authUrl && <Button type="button" variant="outline" size="sm" onClick={() => window.open(oauth.authUrl, "_blank", "noopener,noreferrer")}>
              <ExternalLinkIcon/>{t("connectors.openBrowser")}
            </Button>}
          </div>
          <details className="jv-connector-manual">
            <summary>{t("connectors.manualFallback")}</summary>
            <form className="jv-connector-manual-row" onSubmit={completeManual}>
              <Input value={manualUrl} onChange={event => setManualUrl(event.target.value)} placeholder={t("connectors.manualPlaceholder")}/>
              <Button type="submit" size="sm" variant="outline" disabled={busy || !manualUrl.trim()}>{t("connectors.manualSubmit")}</Button>
            </form>
          </details>
        </>}
        {connector.authKind === "headers" && !isCustom && <form className="jv-connector-drawer-row" onSubmit={saveToken}>
          <Input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={t("connectors.tokenPlaceholder")}/>
          <Button type="submit" className="jv-primary" size="sm" disabled={busy || !token.trim()}>{t("connectors.reconnect")}</Button>
        </form>}
      </div>}

      <BotGrants
        grantedIds={connector.grants.map(grant => grant.botId)}
        onceIds={new Set(connector.grants.filter(grant => grant.scope === "once").map(grant => grant.botId))}
        bots={bots}
        onGrant={async (ids, granted) => {
          let latest = connector;
          for (const botId of ids) latest = await api.grantConnector(connector.id, botId, granted);
          onChanged(latest);
        }}
      />

      {connector.unconfirmed.length > 0 && <div className="jv-connector-exceptions">
        <h4 className="jv-secret-heading">{t("connectors.unconfirmedHeading")}</h4>
        <ul className="jv-connector-exception-list">
          {connector.unconfirmed.map(toolName => <li key={toolName} className="jv-connector-exception-item">
            <code>{toolName}</code>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => toggleUnconfirmed(toolName, false)}>
              {t("connectors.restoreAsk")}
            </Button>
          </li>)}
        </ul>
      </div>}

      <details className="jv-connector-disclosure">
        <summary>
          <span className="jv-connector-disclosure-title"><ChevronRightIcon aria-hidden="true"/>{toolsSummary}</span>
        </summary>
        <div className="jv-connector-disclosure-body">
          <div className="jv-connector-tools-bar">
            {connector.tools.length > SEARCH_TOOL_THRESHOLD && (
              <Input value={toolFilter} onChange={event => setToolFilter(event.target.value)} placeholder={t("connectors.searchTools")}/>
            )}
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run("probe", async () => onChanged(await api.probeConnector(connector.id)))}>
              <RefreshCwIcon/>{t("connectors.refreshTools")}
            </Button>
          </div>
          {!connector.tools.length ? <p className="jv-hint">{t("connectors.noTools")}</p>
            : !visibleTools.length ? <p className="jv-hint">{t("connectors.noMatchingTools")}</p>
            : <div className="jv-connector-tools">
                {visibleTools.map(tool => {
                  const isWrite = tool.write !== false;
                  const skip = connector.unconfirmed.includes(tool.name);
                  return <div key={tool.name} className="jv-connector-tool">
                    <div className="jv-connector-tool-info">
                      <code>{tool.name}</code>
                      <span className="jv-connector-tag" data-kind={isWrite ? "write" : "read"}>
                        {t(isWrite ? "connectors.writeTag" : "connectors.readOnlyTag")}
                      </span>
                      {tool.description && <span className="jv-connector-tool-desc" title={tool.description}>{tool.description}</span>}
                    </div>
                    {isWrite && <label className="jv-connector-toggle">
                      <span>{t("connectors.skipConfirm")}</span>
                      <button type="button" role="switch" className="jv-connector-switch" aria-checked={skip} disabled={busy}
                        onClick={() => toggleUnconfirmed(tool.name, !skip)}/>
                    </label>}
                  </div>;
                })}
              </div>}
        </div>
      </details>

      {connector.uses > 0 && <details className="jv-connector-disclosure" onToggle={event => { if (event.currentTarget.open) loadUses(); }}>
        <summary>
          <span className="jv-connector-disclosure-title"><ChevronRightIcon aria-hidden="true"/>{t("connectors.usesSummary", { count: connector.uses })}</span>
        </summary>
        <div className="jv-connector-disclosure-body">
          {uses && <ul className="jv-secret-uses">
            {uses.map(use => <li key={use.id}>
              <span>{botName(use.botId)} · {use.toolName} · {when(use.at)} · {t(use.outcome === "ok" ? "connectors.useOk" : use.outcome === "denied" ? "connectors.useDenied" : "connectors.useError")}</span>
              {use.detail && <code>{use.detail}</code>}
            </li>)}
          </ul>}
        </div>
      </details>}

      {!isCustom && <details className="jv-connector-disclosure">
        <summary>
          <span className="jv-connector-disclosure-title"><ChevronRightIcon aria-hidden="true"/>{t("connectors.accountSettings")}</span>
        </summary>
        <form className="jv-connector-disclosure-body jv-connector-form" onSubmit={savePreset}>
          <div className="jv-field-grid">
            <label className="jv-field"><span>{t("connectors.name")}</span>
              <Input value={name} maxLength={80} onChange={event => setName(event.target.value)}/></label>
            <div className="jv-field"><span>{t("connectors.identifier")}</span>
              <code className="jv-connector-slug">{connector.slug}</code></div>
          </div>
          {connector.authKind === "headers" && <label className="jv-field">
            <span>{t("connectors.updateToken")}</span>
            <Input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={t("connectors.updateTokenPlaceholder")}/>
          </label>}
          <div className="jv-secret-actions">
            <Button type="submit" variant="outline" size="sm" disabled={busy || (name.trim() === connector.name && !token.trim()) || !name.trim()}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </details>}

      {isCustom && <details className="jv-connector-disclosure">
        <summary>
          <span className="jv-connector-disclosure-title"><ChevronRightIcon aria-hidden="true"/>{t("connectors.connectionSettings")}</span>
        </summary>
        <form className="jv-connector-disclosure-body jv-connector-form" onSubmit={saveCustom}>
          <div className="jv-connector-setting-row">
            <span className="jv-secret-heading">{t("connectors.identifier")}</span>
            <code className="jv-connector-slug">{connector.slug}</code>
          </div>
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
        </form>
      </details>}

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
