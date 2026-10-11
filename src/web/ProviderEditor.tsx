import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeftIcon, ChevronDownIcon, DownloadIcon, PlusIcon, SearchIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { api, type ConfiguredModel, type ModelConnection } from "./api";
import type { ProviderPreset } from "./ProviderPicker";
import { CredentialLogin } from "./CredentialLogin";
import { ModelCard, ProtocolSelect, emptyModel, type ModelDraft } from "./ModelCard";
import { applyAutoconfig, requestAutoconfig } from "./ModelAutoconfig";
import { ProviderMark, connectionStatus } from "./ProviderMark";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

let draftSequence = 0;
const draftModel = (model: ConfiguredModel, selected: boolean, existing = false): ModelDraft => ({ key: `draft-${++draftSequence}`, model, selected, ...(existing ? { originalId: model.id } : {}) });
export function ProviderEditor({ connection, preset, defaultName, saved = false, onBack, onSaved, onConnected, onChanged }: {
  connection?: ModelConnection; preset?: ProviderPreset; saved?: boolean; defaultName: string; onBack: () => void;
  onSaved: (id: string) => Promise<void>; onConnected: (id: string) => Promise<void>; onChanged: () => Promise<void>;
}) {
  const custom = connection ? connection.kind === "custom" : preset?.id === "custom";
  const authType = connection?.authType ?? preset!.authType;
  const [name, setName] = useState(connection ? custom ? connection.providerName : connection.displayName : custom ? "" : defaultName);
  const [url, setUrl] = useState(connection?.baseUrl ?? "");
  const [protocol, setProtocol] = useState(connection?.api ?? preset!.api);
  const [key, setKey] = useState("");
  const [drafts, setDrafts] = useState<ModelDraft[]>(() => (connection?.models ?? []).map(model => draftModel(model, true, true)));
  const [removed, setRemoved] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false), [fetching, setFetching] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(saved ? "已保存" : "");
  const id = useRef(connection?.id);
  function merge(models: ConfiguredModel[]) {
    setDrafts(current => { const ids = new Set(current.map(item => item.model.id)); return [...current, ...models.filter(model => !ids.has(model.id)).map(model => draftModel(model, false))]; });
  }
  useEffect(() => {
    if (custom) return;
    let alive = true; setFetching(true);
    const request = connection ? api.modelCatalog(connection.id) : api.providerModels(preset!.id);
    void request.then(result => { if (alive) merge(result.models); }).catch(reason => { if (alive) setError(reason.message); }).finally(() => { if (alive) setFetching(false); });
    return () => { alive = false; };
  }, [connection?.id, preset?.id, custom]);
  async function discover() {
    setFetching(true); setError(""); setNotice("");
    try {
      const result = await api.discoverModels({ connectionId: id.current, baseUrl: url, api: protocol, ...(key.trim() ? { apiKey: key } : {}) });
      merge(result.models); setNotice(result.models.length ? `获取到 ${result.models.length} 个模型` : "此端点没有返回模型");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "获取失败"); }
    finally { setFetching(false); }
  }
  /** Sequential catalog lookups; results land on the drafts only and are saved with the form. */
  async function autoconfigure(keys: string[], choice?: { provider: string; modelId: string }) {
    const targets = drafts.filter(item => keys.includes(item.key) && item.model.id.trim());
    if (!targets.length) return;
    setError(""); setNotice("");
    setDrafts(current => current.map(row => targets.some(item => item.key === row.key) ? { ...row, auto: { status: "pending" } } : row));
    const counts = { matched: 0, choose: 0, none: 0, error: 0 };
    for (const target of targets) {
      const outcome = await requestAutoconfig(target.model, protocol, choice);
      counts[outcome.status]++;
      setDrafts(current => current.map(row => row.key === target.key ? applyAutoconfig(row, outcome) : row));
    }
    if (targets.length > 1) setNotice([`已配置 ${counts.matched} 个`, counts.choose && `${counts.choose} 个需选择来源`, counts.none && `${counts.none} 个目录未收录`, counts.error && `${counts.error} 个失败`].filter(Boolean).join("，") + "；保存后生效");
  }
  async function ensureConnection(): Promise<string> {
    if (!id.current) {
      const created = await api.createModelConnection({ providerName: preset!.id, displayName: name, kind: "builtin", authType, baseUrl: url, api: protocol });
      id.current = created.id;
    }
    await onConnected(id.current);
    return id.current;
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      let saved: ModelConnection;
      if (!id.current) {
        saved = await api.createModelConnection({ providerName: custom ? name : preset!.id, displayName: name, kind: custom ? "custom" : "builtin", authType, baseUrl: url, api: protocol, ...(custom && key.trim() ? { apiKey: key } : {}) });
        id.current = saved.id;
      } else {
        saved = await api.updateModelConnection(id.current, { displayName: name, ...(custom ? { providerName: name } : {}), baseUrl: url, api: protocol });
        if (custom && key.trim()) await api.saveModelCredential(saved.id, key);
      }
      for (const item of drafts) if (item.selected) await api.saveConnectionModel(saved.id, item.model, item.originalId);
      for (const original of new Set([...removed, ...drafts.filter(item => item.originalId && !item.selected).map(item => item.originalId!)])) await api.deleteConnectionModel(saved.id, original);
      setKey("");
      await onSaved(saved.id); setNotice("已保存");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存未完成"); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!connection || !confirm(`删除「${connection.displayName}」及其模型？`)) return;
    setBusy(true); setError("");
    try { await api.deleteModelConnection(connection.id); await onChanged(); onBack(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); }
    finally { setBusy(false); }
  }
  const visible = drafts.filter(item => `${item.model.id} ${item.model.name}`.toLowerCase().includes(query.toLowerCase()));
  const selected = drafts.filter(item => item.selected).length;
  const title = custom ? connection?.displayName ?? "自定义 API" : connection?.displayName ?? preset!.name;
  const status = connection ? connectionStatus(connection) : null;
  const pending = drafts.some(item => item.auto?.status === "pending");
  return <form className="jv-editor" onChange={() => setNotice("")} onSubmit={event => void save(event)}>
    <header className="jv-editor-header"><Button type="button" variant="ghost" size="icon-sm" className="jv-back" disabled={busy} onClick={onBack} aria-label="返回 Provider 列表"><ArrowLeftIcon/></Button>
      <ProviderMark name={title}/>
      <div className="jv-row-text"><strong>{title}</strong><span>{custom ? "OpenAI / Anthropic compatible" : authType === "oauth" ? "订阅服务" : "API Key"}</span></div>
      {status && <span className="jv-status" data-ok={status.ok || undefined}>{status.label}</span>}
      {connection && <Button type="button" variant="ghost" size="icon-sm" className="jv-danger-icon" disabled={busy} onClick={() => void remove()} aria-label="删除 Provider"><Trash2Icon/></Button>}
    </header>
    <div className="jv-editor-scroll">
      <section className="jv-section" aria-label="连接"><h3 className="jv-section-title">连接</h3>
        <div className="jv-panel">
          {custom ? <>
            <div className="jv-field-grid">
              <label className="jv-field"><span>Provider name</span><Input className="jv-mono" required maxLength={80} aria-label="Provider name" placeholder="my-provider" value={name} onChange={event => setName(event.target.value)}/></label>
              <div className="jv-field"><span>API Protocol</span><ProtocolSelect value={protocol} onChange={setProtocol}/></div>
            </div>
            <label className="jv-field"><span>API URL</span><Input required type="url" aria-label="API URL" value={url} placeholder="https://api.example.com/v1" onChange={event => setUrl(event.target.value)}/></label>
            <label className="jv-field"><span>API Key</span><Input type="password" autoComplete="new-password" aria-label="API Key" placeholder={connection?.configured ? "已保存；留空保持不变" : "输入 API Key"} value={key} onChange={event => setKey(event.target.value)}/></label>
          </> : <>
            <label className="jv-field"><span>连接名称</span><Input required maxLength={100} aria-label="连接名称" value={name} onChange={event => setName(event.target.value)}/></label>
            <CredentialLogin connection={connection} providerName={connection?.providerName ?? preset!.id} authType={authType} ensureConnection={ensureConnection} onChanged={onChanged}/>
            <details className="jv-advanced"><summary><ChevronDownIcon/>连接设置</summary><div className="jv-advanced-fields">
              <label className="jv-field"><span>API URL</span><Input className="jv-mono" value={url} placeholder="使用 Provider 默认地址" onChange={event => setUrl(event.target.value)}/></label>
              <div className="jv-field"><span>API Protocol</span><ProtocolSelect value={protocol} onChange={setProtocol}/></div>
            </div></details>
          </>}
        </div>
      </section>
      <section className="jv-section" aria-label="模型列表">
        <div className="jv-section-head"><h3 className="jv-section-title">模型 <span>已选 {selected} / {drafts.length}</span></h3>
          <div className="jv-section-actions">
            {custom && <Button type="button" variant="ghost" size="sm" disabled={busy || fetching || !url.trim() || !(key.trim() || connection?.configured)} onClick={() => void discover()}><DownloadIcon/>{fetching ? "获取中…" : "获取模型列表"}</Button>}
            {selected > 0 && <Button type="button" variant="ghost" size="sm" disabled={busy || pending} onClick={() => void autoconfigure(drafts.filter(item => item.selected).map(item => item.key))}><SparklesIcon/>自动配置已选</Button>}
            <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts([...drafts, draftModel(emptyModel(), true)])}><PlusIcon/>手动添加</Button>
          </div>
        </div>
        {drafts.length > 6 && <div className="jv-models-filter"><label className="jv-search"><SearchIcon/><input aria-label="筛选模型" placeholder="筛选模型…" value={query} onChange={event => setQuery(event.target.value)}/></label>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts(current => current.map(item => visible.includes(item) ? { ...item, selected: true } : item))}>全选当前结果</Button></div>}
        {fetching && !custom && <p role="status" className="jv-hint">正在读取模型目录…</p>}
        <div className="jv-model-cards">{visible.map(item => <ModelCard key={item.key} draft={item} protocol={protocol} onAutoconfig={choice => void autoconfigure([item.key], choice)} onChange={updated => setDrafts(current => current.map(row => row.key === item.key ? updated : row))} onRemove={() => { if (item.originalId) setRemoved(current => [...current, item.originalId!]); setDrafts(current => current.filter(row => row.key !== item.key)); }}/>)}</div>
        {!fetching && !drafts.length && <div className="jv-empty"><strong>还没有模型</strong><span>{custom ? "获取模型列表，或手动添加模型。" : "可以手动添加模型。"}</span></div>}
      </section>
    </div>
    <footer className="jv-editor-footer"><div aria-live="polite">{error ? <p role="alert">{error}</p> : notice ? <p role="status">{notice}</p> : <p>勾选的模型会在保存后出现在 Bot 的模型列表中。</p>}</div>
      <Button type="submit" className="jv-primary" disabled={busy || fetching || pending}>{busy ? "保存中…" : "保存"}</Button></footer>
  </form>;
}
