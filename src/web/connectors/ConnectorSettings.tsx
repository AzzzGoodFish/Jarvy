import { useEffect, useState, type FormEvent } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { api } from "../api";
import type { Bot } from "../../contract/bots";
import type { Connector, ConnectorAuthKind, ConnectorPreset, ConnectorSafety } from "../../contract/connectors";
import { t } from "../i18n";
import { errorText } from "../errors";
import { useAction } from "../action";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ConnectorItem, safetyKey } from "./ConnectorItem";
import { ConnectorMark } from "./ConnectorMark";
import "../styles/secrets.css";
import "../styles/connectors.css";

const byName = (a: Connector, b: Connector) => a.name.localeCompare(b.name);

/** Settings → Connectors (A95): unified directory of built-in apps (Linear, Notion, Figma) and custom HTTP MCPs. */
export function ConnectorSettings() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [presets, setPresets] = useState<ConnectorPreset[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [autoOAuthId, setAutoOAuthId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy: connectingPreset, error: connectError, run: runConnect } = useAction<string>();

  useEffect(() => {
    void api.connectors().then(res => {
      setConnectors([...res.connectors].sort(byName));
      setPresets(res.presets);
    }).catch(reason => setError(errorText(reason)));
    void api.bots().then(res => setBots(res.bots)).catch(() => setBots([]));
  }, []);

  const changed = (next: Connector) => setConnectors(list => list && list.map(item => item.id === next.id ? next : item));

  const quickConnect = (preset: ConnectorPreset) => void runConnect(preset.id, async () => {
    const authKind: ConnectorAuthKind = preset.kind === "builtin" && preset.id !== "gmail" ? "headers" : preset.authKind;
    const created = await api.createConnector({ provider: preset.id, url: preset.url, authKind, safety: "confirm_writes" });
    setConnectors(list => [...(list ?? []), created].sort(byName));
    setOpen(created.id);
    if (preset.kind === "builtin") return;
    const redirectUri = `${window.location.origin}/api/connectors/oauth/callback`;
    const state = await api.startConnectorOAuth(created.id, redirectUri);
    if (state.phase === "completed") {
      changed((await api.connectorOAuthStatus(created.id)).connector);
      return;
    }
    if (state.authUrl) {
      window.open(state.authUrl, "_blank", "noopener");
      setAutoOAuthId(created.id);
    }
  });

  const configuredProviders = new Set((connectors ?? []).map(item => item.provider));
  const availablePresets = presets.filter(item => item.id !== "custom_mcp" && !configuredProviders.has(item.id));
  const hasAny = Boolean((connectors && connectors.length > 0) || availablePresets.length > 0);

  return <div className="jv-page">
    <header className="jv-page-header">
      <h2>{t("settings.connectors")}</h2>
      {!adding && <Button className="jv-primary" onClick={() => setAdding(true)}><PlusIcon/>{t("connectors.custom")}</Button>}
    </header>

    {adding && <CustomConnectorForm onCancel={() => setAdding(false)} onCreated={created => {
      setAdding(false);
      setConnectors(list => [...(list ?? []), created].sort(byName));
      setOpen(created.id);
    }}/>}

    {hasAny && <section className="jv-section" aria-label={t("settings.connectors")}>
      <div className="jv-list">
        {connectors?.map(connector => <ConnectorItem key={connector.id} connector={connector} bots={bots} open={open === connector.id}
          autoOAuth={autoOAuthId === connector.id}
          onToggle={() => setOpen(open === connector.id ? null : connector.id)}
          onChanged={changed}
          onDeleted={() => { setOpen(null); setConnectors(list => list && list.filter(item => item.id !== connector.id)); }}/>)}
        {availablePresets.map(preset => <div key={preset.id} className="jv-list-row jv-static-row">
          <ConnectorMark badge provider={preset.id}/>
          <span className="jv-row-text"><strong>{preset.name}</strong></span>
          <Button type="button" size="sm" variant="outline" disabled={connectingPreset} onClick={() => quickConnect(preset)}>
            {t("connectors.connect")}
          </Button>
        </div>)}
      </div>
    </section>}

    {connectors && !hasAny && !adding && <div className="jv-empty"><strong>{t("connectors.empty")}</strong></div>}
    {(error || connectError) && <p className="jv-note-error" role="alert">{connectError || error}</p>}
  </div>;
}

function CustomConnectorForm({ onCancel, onCreated }: {
  onCancel: () => void; onCreated: (connector: Connector) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [authKind, setAuthKind] = useState<ConnectorAuthKind>("oauth");
  const [safety, setSafety] = useState<ConnectorSafety>("confirm_writes");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([{ key: "Authorization", value: "" }]);
  const { busy, error, run } = useAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("create", async () => {
      const headers = authKind === "headers"
        ? headerRows.reduce<Record<string, string>>((acc, row) => {
            if (row.key.trim() && row.value) acc[row.key.trim()] = row.value;
            return acc;
          }, {})
        : undefined;
      onCreated(await api.createConnector({
        slug: slug.trim().toLowerCase(),
        name: name.trim() || slug.trim(),
        provider: "custom_mcp",
        url: url.trim(),
        authKind,
        ...(headers && Object.keys(headers).length ? { headers } : {}),
        ...(authKind === "oauth" && clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(authKind === "oauth" && clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        safety,
      }));
    });
  };

  return <form className="jv-panel jv-secret-form" onSubmit={submit} aria-label={t("connectors.custom")}>
    <div className="jv-field-grid">
      <label className="jv-field"><span>{t("connectors.name")}</span>
        <Input required autoFocus value={name} maxLength={80} placeholder="My MCP" onChange={event => setName(event.target.value)}/></label>
      <label className="jv-field"><span>{t("connectors.slug")}</span>
        <Input className="jv-mono" required value={slug} maxLength={48} placeholder={t("connectors.slugPlaceholder")}
          onChange={event => setSlug(event.target.value.toLowerCase())}/></label>
    </div>
    <label className="jv-field"><span>{t("connectors.url")}</span>
      <Input required type="url" value={url} placeholder={t("connectors.urlPlaceholder")} onChange={event => setUrl(event.target.value)}/></label>
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
          <Input type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)}/></label>
      </div>
    </details>}
    {authKind === "headers" && <div className="jv-connector-headers">
      {headerRows.map((row, idx) => <div key={idx} className="jv-header-row">
        <Input className="jv-mono" placeholder={t("connectors.headerName")} value={row.key} onChange={event => setHeaderRows(list => list.map((item, i) => i === idx ? { ...item, key: event.target.value } : item))}/>
        <Input type="password" placeholder={t("connectors.headerValue")} value={row.value} onChange={event => setHeaderRows(list => list.map((item, i) => i === idx ? { ...item, value: event.target.value } : item))}/>
        <Button type="button" size="sm" variant="ghost" onClick={() => setHeaderRows(list => list.filter((_, i) => i !== idx))}>{t("common.cancel")}</Button>
      </div>)}
      <div><Button type="button" size="sm" variant="outline" onClick={() => setHeaderRows(list => [...list, { key: "", value: "" }])}>{t("connectors.addHeader")}</Button></div>
    </div>}
    <div className="jv-connector-setting-row">
      <span className="jv-secret-heading">{t("connectors.safety")}</span>
      <div className="jv-seg" role="radiogroup" aria-label={t("connectors.safety")}>
        {(["confirm_writes", "read_only", "auto"] as const).map(mode => (
          <button key={mode} type="button" role="radio" aria-checked={safety === mode} onClick={() => setSafety(mode)}>
            {t(safetyKey(mode))}
          </button>
        ))}
      </div>
    </div>
    {error && <p className="jv-note-error" role="alert">{error}</p>}
    <div className="jv-secret-actions">
      <Button type="button" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button type="submit" className="jv-primary" disabled={busy || !slug.trim() || !url.trim()}>{t("common.save")}</Button>
    </div>
  </form>;
}
