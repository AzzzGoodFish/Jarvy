import { useState } from "react";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import type { ModelConnection } from "./api";
import { ProviderPicker, GROUPS, type ProviderPreset } from "./ProviderPicker";
import { ProviderEditor } from "./ProviderEditor";
import { Button } from "./components/ui/button";
import { ProviderMark, connectionStatus } from "./ProviderMark";

export function ModelSettings({ connections, onChanged }: { connections: ModelConnection[]; onChanged: () => Promise<void> }) {
  const [page, setPage] = useState<"list" | "choose" | "editor">("list");
  const [preset, setPreset] = useState<ProviderPreset>();
  const [id, setId] = useState<string>();
  const [revision, setRevision] = useState(0);
  const back = () => { setPage("list"); setId(undefined); setPreset(undefined); setRevision(0); };
  const group = (connection: ModelConnection) => connection.kind === "custom" ? "自定义 API" : connection.authType === "oauth" ? "订阅服务" : "API Key";
  let defaultName = preset?.name ?? "";
  if (preset) { let suffix = 2; while (connections.some(item => item.displayName === defaultName)) defaultName = `${preset.name} ${suffix++}`; }
  if (page === "choose") return <ProviderPicker onBack={back} onSelect={selected => { setPreset(selected); setId(undefined); setPage("editor"); }}/>;
  if (page === "editor") return <ProviderEditor key={revision} connection={connections.find(item => item.id === id)} preset={preset} defaultName={defaultName} saved={revision > 0}
    onBack={back} onChanged={onChanged} onConnected={async connectedId => { await onChanged(); setId(connectedId); setPreset(undefined); }} onSaved={async savedId => { await onChanged(); setId(savedId); setPreset(undefined); setRevision(value => value + 1); }}/>;
  return <div className="jv-page">
    <header className="jv-page-header"><div><h2>模型</h2><p>连接模型服务，Bot 从这里选择模型。</p></div>
      <Button className="jv-primary" onClick={() => setPage("choose")}><PlusIcon/>添加 Provider</Button></header>
    {!connections.length && <div className="jv-empty"><strong>还没有模型连接</strong><span>添加一个 Provider 后，就能为 Bot 选择模型。</span></div>}
    {GROUPS.filter(category => connections.some(item => group(item) === category)).map(category => <section className="jv-section" key={category} aria-label={category}>
      <h3 className="jv-section-title">{category}</h3>
      <div className="jv-list">{connections.filter(item => group(item) === category).map(connection => {
        const status = connectionStatus(connection);
        return <button type="button" key={connection.id} className="jv-list-row" onClick={() => { setId(connection.id); setPreset(undefined); setPage("editor"); }}>
          <ProviderMark name={connection.displayName}/>
          <span className="jv-row-text"><strong>{connection.displayName}</strong><span>{connection.models.length ? `${connection.models.length} 个模型` : "尚未添加模型"}</span></span>
          <span className="jv-status" data-ok={status.ok || undefined}>{status.label}</span><ChevronRightIcon className="jv-row-chevron"/>
        </button>;
      })}</div>
    </section>)}
  </div>;
}
