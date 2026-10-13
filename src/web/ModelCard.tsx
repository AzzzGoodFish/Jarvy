import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ConfiguredModel } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";
import { AutoconfigPanel, type AutoState } from "./ModelAutoconfig";
import { ThinkingSettings } from "./ThinkingSettings";
import { t } from "./i18n";
import type { Key } from "./i18n/keys";

export const PROTOCOLS = [{ id: "openai-completions", label: "OpenAI · Chat Completions" }, { id: "openai-responses", label: "OpenAI · Responses" }, { id: "anthropic-messages", label: "Anthropic · Messages" }, { id: "google-generative-ai", label: "Google · Gemini" }];
export const emptyModel = (): ConfiguredModel => ({ id: "", name: "", reasoning: false, input: ["text"], contextWindow: null, maxTokens: null, thinkingFormat: "", thinkingLevelMap: {}, compat: {}, cost: null });
export interface ModelDraft { key: string; originalId?: string; selected: boolean; model: ConfiguredModel; auto?: AutoState; }
export function ProtocolSelect({ value, onChange, allowDefault = false }: { value: string; onChange: (value: string) => void; allowDefault?: boolean }) {
  const options = PROTOCOLS.some(item => item.id === value) || !value ? PROTOCOLS : [...PROTOCOLS, { id: value, label: value }];
  return <Select value={value || "default"} onValueChange={item => onChange(item === "default" ? "" : item)}><SelectTrigger aria-label={t("editor.protocol")}><SelectValue/></SelectTrigger><SelectContent className="jv-select-menu">
    {allowDefault && <SelectItem value="default">{t("card.defaultProtocol")}</SelectItem>}{options.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
  </SelectContent></Select>;
}
/** 1000000 → 1M, 272000 → 272K (context size chip). */
const compactTokens = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(2)}M` : value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
const AUTO_TAGS: Partial<Record<AutoState["status"], Key>> = { pending: "auto.pending", choose: "auto.tagChoose", none: "auto.tagNone", error: "auto.failed" };
/** Raw Pi compat flags (protocol-specific); filled by autoconfigure, editable for gateways that differ. */
function CompatField({ value, onChange }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  const format = (item: Record<string, unknown>) => Object.keys(item).length ? JSON.stringify(item, null, 2) : "";
  const [text, setText] = useState(() => format(value));
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  // Autoconfigure replaces compat from outside; resync unless the text already parses to it.
  useEffect(() => { try { if (JSON.stringify(JSON.parse(text || "{}")) === JSON.stringify(value)) return; } catch { /* resync */ } setText(format(value)); setError(""); input.current?.setCustomValidity(""); }, [value]);
  return <label className="jv-field"><span>{t("card.compat")}</span>
    <Textarea ref={input} className="jv-mono jv-compat" rows={Math.min(10, Math.max(2, text.split("\n").length))} placeholder="{}" value={text} onChange={event => {
      setText(event.target.value);
      try { const parsed = JSON.parse(event.target.value || "{}"); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); onChange(parsed); setError(""); event.currentTarget.setCustomValidity(""); }
      catch { setError(t("card.jsonObject")); event.currentTarget.setCustomValidity(t("card.jsonObject")); }
    }}/>{error && <small role="alert">{error}</small>}
  </label>;
}
export function ModelCard({ draft, protocol, onChange, onRemove, onAutoconfig }: { draft: ModelDraft; protocol: string; onChange: (draft: ModelDraft) => void; onRemove: () => void; onAutoconfig: (choice?: { provider: string; modelId: string }) => void }) {
  const { model } = draft;
  const [open, setOpen] = useState(!model.id);
  const [prices, setPrices] = useState(false);
  const [headers, setHeaders] = useState(() => (model.headerNames ?? []).map(name => ({ name, value: "", saved: true })));
  const set = (patch: Partial<ConfiguredModel>) => onChange({ ...draft, model: { ...model, ...patch } });
  const field = (label: string, node: React.ReactNode) => <label className="jv-field"><span>{label}</span>{node}</label>;
  const setHeader = (index: number, key: "name" | "value", value: string) => {
    const next = headers.map((item, i) => i === index ? { ...item, [key]: value } : item); setHeaders(next);
    const updates = { ...model.headerUpdates };
    if (!headers[index]!.saved && headers[index]!.name && headers[index]!.name !== next[index]!.name) updates[headers[index]!.name] = null;
    for (const item of next) if (item.name && (item.value || !item.saved)) updates[item.name] = item.value;
    set({ headerUpdates: updates });
  };
  return <article className={`jv-model-card ${draft.selected ? "is-selected" : ""}`}>
    <div className="jv-model-summary"><input type="checkbox" checked={draft.selected} aria-label={t("card.use", { name: model.id || t("card.newModel") })} onChange={event => onChange({ ...draft, selected: event.target.checked })}/>
      <button type="button" aria-expanded={open} className="jv-model-expand" onClick={() => setOpen(!open)}>
        <span className="jv-row-text"><strong>{model.name || model.id || t("card.newModel")}</strong><span className="jv-mono">{model.id || t("card.enterId")}</span></span>
        <span className="jv-chips">{model.contextWindow && <span className="jv-chip">{compactTokens(model.contextWindow)}</span>}{model.input.includes("image") && <span className="jv-chip">{t("card.image")}</span>}{model.reasoning && <span className="jv-chip">{t("card.reasoning")}</span>}
          {draft.auto && AUTO_TAGS[draft.auto.status] && <span className="jv-chip jv-chip-warn">{t(AUTO_TAGS[draft.auto.status]!)}</span>}</span>
        <ChevronDownIcon className="jv-expand-icon"/>
      </button>
      <Button type="button" variant="ghost" size="icon-sm" className="jv-model-remove" aria-label={t("card.remove", { name: model.id || t("card.newModel") })} onClick={onRemove}><Trash2Icon/></Button>
    </div>
    {open && <div className="jv-model-fields">
      <div className="jv-field-grid">{field(t("card.modelId"), <Input className="jv-mono" required value={model.id} onChange={event => set({ id: event.target.value })} placeholder="model-id"/>)}{field(t("card.modelName"), <Input value={model.name} onChange={event => set({ name: event.target.value })} placeholder={t("card.optional")}/>)}</div>
      <AutoconfigPanel state={draft.auto} modelId={model.id} onRun={onAutoconfig}/>
      <section><h4>{t("card.capabilities")}</h4><div className="flex flex-wrap gap-5"><label className="jarvy-model-check"><input type="checkbox" checked={model.reasoning} onChange={event => set({ reasoning: event.target.checked })}/>{t("card.reasoningThinking")}</label><label className="jarvy-model-check"><input type="checkbox" checked={model.input.includes("image")} onChange={event => set({ input: event.target.checked ? ["text", "image"] : ["text"] })}/>{t("card.imageInput")}</label></div></section>
      {model.reasoning && <ThinkingSettings model={model} api={model.api || protocol} onChange={set}/>}
      <section><div className="flex items-center justify-between"><h4>{t("card.specs")}</h4><Button type="button" variant="link" size="sm" onClick={() => setPrices(!prices)}>{t(prices ? "card.hidePrices" : "card.editPrices")}</Button></div>
        <div className="jv-field-grid">{field(t("card.context"), <Input type="number" min={1} value={model.contextWindow ?? ""} placeholder={t("card.notProvided")} onChange={event => set({ contextWindow: event.target.value ? Number(event.target.value) : null })}/>)}{field(t("card.maxOutput"), <Input type="number" min={1} value={model.maxTokens ?? ""} placeholder={t("card.notProvided")} onChange={event => set({ maxTokens: event.target.value ? Number(event.target.value) : null })}/>)}</div>
        <h4 className="jv-cost-title">{t("card.costTitle")}</h4><div className="jv-costs">{([['input', 'card.costInput'], ['output', 'card.costOutput'], ['cacheRead', 'card.costCacheRead'], ['cacheWrite', 'card.costCacheWrite']] as const).map(([key, label]) => <div key={key}><Label>{t(label)}</Label>{prices ? <Input type="number" step="any" min={0} value={model.cost?.[key] ?? ""} onChange={event => set({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...model.cost, [key]: Number(event.target.value) } })}/> : <span>{model.cost?.[key] ?? t("card.notProvided")}</span>}</div>)}</div>
      </section>
      <details className="jv-advanced"><summary>{t("card.advanced")}<ChevronDownIcon className="size-4"/></summary>
        <div className="jv-advanced-fields"><div className="jv-field"><span>{t("card.apiOverride")}</span><ProtocolSelect allowDefault value={model.api ?? ""} onChange={api => set({ api })}/></div>
          <div className="jv-field"><span>{t("card.headers")}</span>{headers.map((header, index) => <div className="jv-header-row" key={index}>
            <Input className="jv-mono" aria-label="Header Name" placeholder="Header-Name" readOnly={header.saved} value={header.name} onChange={event => setHeader(index, "name", event.target.value)}/>
            <Input aria-label="Header Value" type="password" autoComplete="off" placeholder={header.saved ? t("card.headerSaved") : "value"} value={header.value} onChange={event => setHeader(index, "value", event.target.value)}/>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t("card.removeHeader")} onClick={() => { setHeaders(headers.filter((_, i) => i !== index)); if (header.name) set({ headerUpdates: { ...model.headerUpdates, [header.name]: null } }); }}><Trash2Icon/></Button>
          </div>)}<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setHeaders([...headers, { name: "", value: "", saved: false }])}><PlusIcon/>{t("card.addHeader")}</Button></div>
          <CompatField value={model.compat} onChange={compat => set({ compat })}/>
        </div>
      </details>
    </div>}
  </article>;
}
