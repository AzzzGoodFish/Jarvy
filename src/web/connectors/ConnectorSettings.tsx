import { useEffect, useState, type FormEvent } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { api } from "../api";
import type { Bot } from "../../contract/bots";
import type { Connector, ConnectorAuthKind, ConnectorPreset } from "../../contract/connectors";
import { t } from "../i18n";
import { errorText } from "../errors";
import { useAction } from "../action";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ConnectorItem } from "./ConnectorItem";
import { ConnectorPresetRow } from "./ConnectorPresetRow";
import "../styles/secrets.css";
import "../styles/connectors.css";

const byName = (a: Connector, b: Connector) => a.name.localeCompare(b.name);
const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
const defaultOrigin = () => window.location.protocol === "http:" && !isLoopback(window.location.hostname)
  ? `https://${window.location.host}` : window.location.origin;

/** Settings → Connectors (A102): calm two-part directory — connected apps on top, available apps below,
 * and an inline form for custom remote HTTP MCP servers. */
export function ConnectorSettings() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [presets, setPresets] = useState<ConnectorPreset[]>([]);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.connectors().then(res => {
      setConnectors([...res.connectors].sort(byName));
      setPresets(res.presets);
      setPublicUrl(res.publicUrl);
    }).catch(reason => setError(errorText(reason)));
    void api.bots().then(res => setBots(res.bots)).catch(() => setBots([]));
  }, []);

  const callbackUrl = `${publicUrl ?? defaultOrigin()}/api/connectors/oauth/callback`;
  const connectedProviders = new Set((connectors ?? []).map(item => item.provider));
  const availablePresets = presets.filter(preset => preset.id !== "custom_mcp" && !connectedProviders.has(preset.id));

  const onAdded = (created: Connector) => {
    setConnectors(list => [...(list ?? []), created].sort(byName));
    setOpen(created.id);
  };
  const onChanged = (updated: Connector) => setConnectors(list => list && list.map(item => item.id === updated.id ? updated : item));
  const onDeleted = (id: string) => {
    setOpen(current => current === id ? null : current);
    setConnectors(list => list && list.filter(item => item.id !== id));
  };

  return <div className="jv-page">
    <header className="jv-page-header">
      <h2>{t("settings.connectors")}</h2>
      {!adding && <Button className="jv-primary" onClick={() => setAdding(true)}><PlusIcon/>{t("connectors.addCustom")}</Button>}
    </header>

    {adding && <CustomMcpForm onCancel={() => setAdding(false)} onCreated={created => { setAdding(false); onAdded(created); }}/>}

    {connectors && connectors.length > 0 && <section className="jv-section" aria-labelledby="connectors-connected">
      {availablePresets.length > 0 && <h3 id="connectors-connected" className="jv-section-title">{t("connectors.connectedSection")}</h3>}
      <div className="jv-list">
        {connectors.map(connector => (
          <ConnectorItem key={connector.id} connector={connector} bots={bots} open={open === connector.id} callbackUrl={callbackUrl}
            onToggle={() => setOpen(open === connector.id ? null : connector.id)}
            onChanged={onChanged} onDeleted={() => onDeleted(connector.id)}/>
        ))}
      </div>
    </section>}

    {availablePresets.length > 0 && <section className="jv-section" aria-labelledby="connectors-available">
      {connectors && connectors.length > 0 && <h3 id="connectors-available" className="jv-section-title">{t("connectors.availableSection")}</h3>}
      <div className="jv-list">
        {availablePresets.map(preset => (
          <ConnectorPresetRow key={preset.id} preset={preset} callbackUrl={callbackUrl} onConnected={onAdded}/>
        ))}
      </div>
    </section>}

    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </div>;
}

function CustomMcpForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (connector: Connector) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authKind, setAuthKind] = useState<ConnectorAuthKind>("oauth");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([{ key: "Authorization", value: "" }]);
  const { busy, error, run } = useAction();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("create", async () => {
      const headers = authKind === "headers"
        ? Object.fromEntries(headerRows.filter(row => row.key.trim() && row.value).map(row => [row.key.trim(), row.value]))
        : undefined;
      onCreated(await api.createConnector({
        provider: "custom_mcp",
        name: name.trim(),
        url: url.trim(),
        authKind,
        ...(headers && Object.keys(headers).length ? { headers } : {}),
        ...(authKind === "oauth" && clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(authKind === "oauth" && clientSecret ? { clientSecret } : {}),
      }));
    });
  };

  return <form className="jv-panel jv-secret-form jv-connector-form" onSubmit={submit} aria-label={t("connectors.addCustom")}>
    <div className="jv-field-grid">
      <label className="jv-field"><span>{t("connectors.name")}</span>
        <Input required autoFocus maxLength={80} placeholder={t("connectors.namePlaceholder")} value={name} onChange={event => setName(event.target.value)}/></label>
      <label className="jv-field"><span>{t("connectors.url")}</span>
        <Input type="url" required placeholder={t("connectors.urlPlaceholder")} value={url} onChange={event => setUrl(event.target.value)}/></label>
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
          <Input type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)}/></label>
      </div>
    </details>}
    {authKind === "headers" && <div className="jv-connector-headers">
      {headerRows.map((row, idx) => <div key={idx} className="jv-header-row">
        <Input className="jv-mono" placeholder={t("connectors.headerName")} value={row.key} onChange={event => setHeaderRows(list => list.map((item, i) => i === idx ? { ...item, key: event.target.value } : item))}/>
        <Input type="password" placeholder={t("connectors.headerValue")} value={row.value} onChange={event => setHeaderRows(list => list.map((item, i) => i === idx ? { ...item, value: event.target.value } : item))}/>
        <Button type="button" size="sm" variant="ghost" onClick={() => setHeaderRows(list => list.filter((_, i) => i !== idx))}>{t("common.cancel")}</Button>
      </div>)}
      <div><Button type="button" size="sm" variant="outline" onClick={() => setHeaderRows(list => [...list, { key: "Authorization", value: "" }])}>{t("connectors.addHeader")}</Button></div>
    </div>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
    <div className="jv-secret-actions">
      <Button type="button" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button type="submit" className="jv-primary" disabled={busy || !name.trim() || !url.trim()}>{t("connectors.connect")}</Button>
    </div>
  </form>;
}
