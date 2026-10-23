import { useState } from "react";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import type { ModelConnection } from "./api";
import { ProviderPicker, GROUPS, groupOf, type ProviderPreset } from "./ProviderPicker";
import { ProviderEditor } from "./ProviderEditor";
import { Button } from "./components/ui/button";
import { ProviderMark, connectionStatus } from "./ProviderMark";
import { t } from "./i18n";

export function ModelSettings({ connections, onChanged }: { connections: ModelConnection[]; onChanged: () => Promise<void> }) {
  const [page, setPage] = useState<"list" | "choose" | "editor">("list");
  const [preset, setPreset] = useState<ProviderPreset>();
  const [id, setId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const back = () => { setPage("list"); setId(undefined); setPreset(undefined); setRevision(0); };
  const group = (connection: ModelConnection) => groupOf({ authType: connection.authType, custom: connection.kind === "custom" });
  let defaultName = preset?.name ?? "";
  if (preset) { let suffix = 2; while (connections.some(item => item.displayName === defaultName)) defaultName = `${preset.name} ${suffix++}`; }
  if (page === "choose") return <ProviderPicker onBack={back} onSelect={selected => { setPreset(selected); setId(undefined); setPage("editor"); }}/>;
  if (page === "editor") return <ProviderEditor key={revision} connection={connections.find(item => item.id === id)} preset={preset} defaultName={defaultName} saved={revision > 0}
    onBack={back} onChanged={onChanged} onConnected={async connectedId => { await onChanged(); setId(connectedId); setPreset(undefined); }} onSaved={async savedId => { await onChanged(); setId(savedId); setPreset(undefined); setRevision(value => value + 1); }}/>;
  return <div className="jv-page">
    <header className="jv-page-header"><h2>{t("settings.models")}</h2>
      <Button className="jv-primary" onClick={() => setPage("choose")}><PlusIcon/>{t("models.add")}</Button></header>
    {!connections.length && <div className="jv-empty"><strong>{t("models.empty")}</strong></div>}
    {GROUPS.filter(category => connections.some(item => group(item) === category.id)).map(({ id, label }) => <section className="jv-section" key={id} aria-label={t(label)}>
      <h3 className="jv-section-title">{t(label)}</h3>
      <div className="jv-list">{connections.filter(item => group(item) === id).map(connection => {
        const status = connectionStatus(connection);
        return <button type="button" key={connection.id} className="jv-list-row" onClick={() => { setId(connection.id); setPreset(undefined); setPage("editor"); }}>
          <ProviderMark name={connection.displayName} provider={connection.kind === "builtin" ? connection.providerName : undefined}/>
          <span className="jv-row-text"><strong>{connection.displayName}</strong><span>{connection.models.length ? t("models.count", { count: connection.models.length }) : t("models.none")}</span></span>
          <span className="jv-status" data-ok={status.ok || undefined}>{status.label}</span><ChevronRightIcon className="jv-row-chevron"/>
        </button>;
      })}</div>
    </section>)}
  </div>;
}
