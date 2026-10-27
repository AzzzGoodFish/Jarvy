import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeftIcon, ChevronDownIcon, DownloadIcon, PlusIcon, RotateCcwIcon, SearchIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { api, type ConfiguredModel, type ModelConnection, type ModelResetPlan } from "./api";
import type { ProviderPreset } from "./ProviderPicker";
import { CredentialLogin } from "./CredentialLogin";
import { ModelCard, ProtocolSelect, emptyModel, type ModelDraft } from "./ModelCard";
import { applyAutoconfig, requestAutoconfig } from "./ModelAutoconfig";
import { ProviderMark, connectionStatus } from "./ProviderMark";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { t } from "./i18n";
import { errorText } from "./errors";
import { useAction } from "./action";

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
  const { busy, error, setError, run } = useAction(), [fetching, setFetching] = useState(false);
  const [notice, setNotice] = useState(saved ? t("editor.saved") : "");
  const [resetPlan, setResetPlan] = useState<ModelResetPlan | null>(null);
  const id = useRef(connection?.id);
  function merge(models: ConfiguredModel[]) {
    setDrafts(current => { const ids = new Set(current.map(item => item.model.id)); return [...current, ...models.filter(model => !ids.has(model.id)).map(model => draftModel(model, false))]; });
  }
  useEffect(() => {
    if (custom) return;
    let alive = true; setFetching(true);
    const request = connection ? api.modelCatalog(connection.id) : api.providerModels(preset!.id);
    void request.then(result => { if (alive) merge(result.models); }).catch(reason => { if (alive) setError(errorText(reason, "editor.fetchFailed")); }).finally(() => { if (alive) setFetching(false); });
    return () => { alive = false; };
  }, [connection?.id, preset?.id, custom]);
  async function discover() {
    setFetching(true); setError(""); setNotice("");
    try {
      const result = await api.discoverModels({ connectionId: id.current, baseUrl: url, api: protocol, ...(key.trim() ? { apiKey: key } : {}) });
      merge(result.models); setNotice(result.models.length ? t("editor.fetched", { count: result.models.length }) : t("editor.noneReturned"));
    } catch (reason) { setError(errorText(reason, "editor.fetchFailed")); }
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
    if (targets.length > 1) setNotice(t("editor.autoSummary", { parts: [t("editor.autoMatched", { count: counts.matched }), counts.choose && t("editor.autoChoose", { count: counts.choose }),
      counts.none && t("editor.autoNone", { count: counts.none }), counts.error && t("editor.autoFailed", { count: counts.error })].filter(Boolean).join(t("common.listSeparator")) }));
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
    event.preventDefault(); setNotice("");
    await run("save", async () => {
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
      await onSaved(saved.id); setNotice(t("editor.saved"));
    }, "editor.saveFailed");
  }
  /** Reset to the catalog (A62): the server checks pi.dev and says what would happen; confirmed, it does it and the
   * drafts start again from the result. */
  async function askReset() {
    setNotice("");
    await run("reset", async () => setResetPlan(await api.modelResetPlan(connection!.id)), "editor.resetFailed");
  }
  async function reset() {
    setNotice("");
    const done = await run("reset", async () => {
      const result = await api.resetModelConnection(connection!.id);
      setResetPlan(null); setRemoved([]); setUrl(result.baseUrl); setProtocol(result.api);
      setDrafts(result.models.map(model => draftModel(model, true, true)));
      merge((await api.modelCatalog(result.id)).models);
      await onChanged();
    }, "editor.resetFailed");
    if (done) setNotice(t("editor.resetDone"));
  }
  async function remove() {
    if (!connection || !confirm(t("editor.confirmDelete", { name: connection.displayName }))) return;
    await run("delete", async () => { await api.deleteModelConnection(connection.id); await onChanged(); onBack(); }, "editor.deleteFailed");
  }
  const visible = drafts.filter(item => `${item.model.id} ${item.model.name}`.toLowerCase().includes(query.toLowerCase()));
  const selected = drafts.filter(item => item.selected).length;
  const title = custom ? connection?.displayName ?? t("group.custom") : connection?.displayName ?? preset!.name;
  const status = connection ? connectionStatus(connection) : null;
  const pending = drafts.some(item => item.auto?.status === "pending");
  return <form className="jv-editor" onChange={() => setNotice("")} onSubmit={event => void save(event)}>
    <header className="jv-editor-header"><Button type="button" variant="ghost" size="icon-sm" className="jv-back" disabled={busy} onClick={onBack} aria-label={t("editor.back")}><ArrowLeftIcon/></Button>
      <ProviderMark name={title} provider={connection ? connection.kind === "builtin" ? connection.providerName : undefined : preset?.id}/>
      <div className="jv-row-text"><strong>{title}</strong><span>{custom ? "OpenAI / Anthropic compatible" : t(authType === "oauth" ? "group.subscription" : "group.apiKey")}</span></div>
      {status && <span className="jv-status" data-ok={status.ok || undefined}>{status.label}</span>}
      {connection && <Button type="button" variant="ghost" size="icon-sm" className="jv-danger-icon" disabled={busy} onClick={() => void remove()} aria-label={t("editor.delete")}><Trash2Icon/></Button>}
    </header>
    <div className="jv-editor-scroll">
      <section className="jv-section" aria-label={t("editor.connection")}><h3 className="jv-section-title">{t("editor.connection")}</h3>
        <div className="jv-panel">
          {custom ? <>
            <div className="jv-field-grid">
              <label className="jv-field"><span>{t("editor.providerName")}</span><Input className="jv-mono" required maxLength={80} aria-label={t("editor.providerName")} placeholder="my-provider" value={name} onChange={event => setName(event.target.value)}/></label>
              <div className="jv-field"><span>{t("editor.protocol")}</span><ProtocolSelect value={protocol} onChange={setProtocol}/></div>
            </div>
            <label className="jv-field"><span>{t("editor.url")}</span><Input required type="url" aria-label={t("editor.url")} value={url} placeholder="https://api.example.com/v1" onChange={event => setUrl(event.target.value)}/></label>
            <label className="jv-field"><span>{t("editor.key")}</span><Input type="password" autoComplete="new-password" aria-label={t("editor.key")} placeholder={t(connection?.configured ? "editor.keySaved" : "editor.keyPlaceholder")} value={key} onChange={event => setKey(event.target.value)}/></label>
          </> : <>
            <label className="jv-field"><span>{t("editor.name")}</span><Input required maxLength={100} aria-label={t("editor.name")} value={name} onChange={event => setName(event.target.value)}/></label>
            <CredentialLogin connection={connection} providerName={connection?.providerName ?? preset!.id} authType={authType} ensureConnection={ensureConnection} onChanged={onChanged}/>
            <details className="jv-advanced"><summary><ChevronDownIcon/>{t("editor.settings")}</summary><div className="jv-advanced-fields">
              <label className="jv-field"><span>{t("editor.url")}</span><Input className="jv-mono" value={url} placeholder={t("editor.defaultUrl")} onChange={event => setUrl(event.target.value)}/></label>
              <div className="jv-field"><span>API Protocol</span><ProtocolSelect value={protocol} onChange={setProtocol}/></div>
            </div></details>
          </>}
        </div>
      </section>
      <section className="jv-section" aria-label={t("editor.models")}>
        <div className="jv-section-head"><h3 className="jv-section-title">{t("settings.models")} <span>{t("editor.selected", { selected, total: drafts.length })}</span></h3>
          <div className="jv-section-actions">
            {custom && <Button type="button" variant="ghost" size="sm" disabled={busy || fetching || !url.trim() || !(key.trim() || connection?.configured)} onClick={() => void discover()}><DownloadIcon/>{t(fetching ? "editor.fetching" : "editor.fetch")}</Button>}
            {selected > 0 && <Button type="button" variant="ghost" size="sm" disabled={busy || pending} onClick={() => void autoconfigure(drafts.filter(item => item.selected).map(item => item.key))}><SparklesIcon/>{t("editor.autoSelected")}</Button>}
            <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts([...drafts, draftModel(emptyModel(), true)])}><PlusIcon/>{t("editor.addManually")}</Button>
            {connection && !custom && <Button type="button" variant="ghost" size="sm" disabled={busy || fetching || !!resetPlan} onClick={() => void askReset()}><RotateCcwIcon/>{t("editor.reset")}</Button>}
          </div>
        </div>
        {resetPlan && <ResetConfirm plan={resetPlan} busy={busy} onCancel={() => setResetPlan(null)} onConfirm={() => void reset()}/>}
        {drafts.length > 6 && <div className="jv-models-filter"><label className="jv-search"><SearchIcon/><input aria-label={t("editor.filter")} placeholder={t("editor.filterPlaceholder")} value={query} onChange={event => setQuery(event.target.value)}/></label>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts(current => current.map(item => visible.includes(item) ? { ...item, selected: true } : item))}>{t("editor.selectVisible")}</Button></div>}
        {fetching && !custom && <p role="status" className="jv-hint">{t("editor.loadingCatalog")}</p>}
        <div className="jv-model-cards">{visible.map(item => <ModelCard key={item.key} draft={item} protocol={protocol} onAutoconfig={choice => void autoconfigure([item.key], choice)} onChange={updated => setDrafts(current => current.map(row => row.key === item.key ? updated : row))} onRemove={() => { if (item.originalId) setRemoved(current => [...current, item.originalId!]); setDrafts(current => current.filter(row => row.key !== item.key)); }}/>)}</div>
        {!fetching && !drafts.length && <div className="jv-empty"><strong>{t("editor.empty")}</strong><span>{t(custom ? "editor.emptyCustom" : "editor.emptyBuiltin")}</span></div>}
      </section>
    </div>
    <footer className="jv-editor-footer"><div aria-live="polite">{error ? <p role="alert">{error}</p> : notice ? <p role="status">{notice}</p> : null}</div>
      <Button type="submit" className="jv-primary" disabled={busy || fetching || pending}>{t(busy ? "editor.saving" : "editor.save")}</Button></footer>
  </form>;
}

/** What resetting will do, asked in place: models set back, models removed and the Bots that then need another model. */
function ResetConfirm({ plan, busy, onCancel, onConfirm }: { plan: ModelResetPlan; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const bots = [...new Set(plan.removed.flatMap(model => model.bots))], separator = t("common.listSeparator");
  return <div className="jv-reset-confirm" role="group" aria-label={t("editor.resetTitle")}>
    <strong>{t("editor.resetTitle")}</strong>
    {plan.reset.length > 0 && <p>{t("editor.resetModels", { count: plan.reset.length })}</p>}
    {plan.removed.length > 0 && <p>{t("editor.resetRemoves", { count: plan.removed.length, names: plan.removed.map(model => model.name || model.id).join(separator) })}</p>}
    {bots.length > 0 && <p className="jv-reset-bots">{t("editor.resetBots", { count: bots.length, bots: bots.join(separator) })}</p>}
    <p>{t("editor.resetKeeps")}</p>
    <div className="jv-reset-actions"><Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button type="button" className="jv-primary" size="sm" disabled={busy} onClick={onConfirm}>{t("editor.resetConfirm")}</Button></div>
  </div>;
}
