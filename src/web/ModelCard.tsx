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

export const PROTOCOLS = [{ id: "openai-completions", label: "OpenAI · Chat Completions" }, { id: "openai-responses", label: "OpenAI · Responses" }, { id: "anthropic-messages", label: "Anthropic · Messages" }, { id: "google-generative-ai", label: "Google · Gemini" }];
export const emptyModel = (): ConfiguredModel => ({ id: "", name: "", reasoning: false, input: ["text"], contextWindow: null, maxTokens: null, thinkingFormat: "", thinkingLevelMap: {}, compat: {}, cost: null });
export interface ModelDraft { key: string; originalId?: string; selected: boolean; model: ConfiguredModel; auto?: AutoState; }
export function ProtocolSelect({ value, onChange, allowDefault = false }: { value: string; onChange: (value: string) => void; allowDefault?: boolean }) {
  const options = PROTOCOLS.some(item => item.id === value) || !value ? PROTOCOLS : [...PROTOCOLS, { id: value, label: value }];
  return <Select value={value || "default"} onValueChange={item => onChange(item === "default" ? "" : item)}><SelectTrigger aria-label="API Protocol"><SelectValue/></SelectTrigger><SelectContent className="jv-select-menu">
    {allowDefault && <SelectItem value="default">使用 Provider 默认协议</SelectItem>}{options.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
  </SelectContent></Select>;
}
/** 1000000 → 1M, 272000 → 272K (context size chip). */
const compactTokens = (value: number) => value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(2)}M` : value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
const AUTO_TAGS: Partial<Record<AutoState["status"], string>> = { pending: "配置中…", choose: "需选择配置来源", none: "目录未收录", error: "自动配置失败" };
/** Raw Pi compat flags (protocol-specific); filled by autoconfigure, editable for gateways that differ. */
function CompatField({ value, onChange }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  const format = (item: Record<string, unknown>) => Object.keys(item).length ? JSON.stringify(item, null, 2) : "";
  const [text, setText] = useState(() => format(value));
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  // Autoconfigure replaces compat from outside; resync unless the text already parses to it.
  useEffect(() => { try { if (JSON.stringify(JSON.parse(text || "{}")) === JSON.stringify(value)) return; } catch { /* resync */ } setText(format(value)); setError(""); input.current?.setCustomValidity(""); }, [value]);
  return <label className="jv-field"><span>兼容参数 · compat</span>
    <Textarea ref={input} className="jv-mono jv-compat" rows={Math.min(10, Math.max(2, text.split("\n").length))} placeholder="{}" value={text} onChange={event => {
      setText(event.target.value);
      try { const parsed = JSON.parse(event.target.value || "{}"); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); onChange(parsed); setError(""); event.currentTarget.setCustomValidity(""); }
      catch { setError("请输入 JSON 对象"); event.currentTarget.setCustomValidity("请输入 JSON 对象"); }
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
    <div className="jv-model-summary"><input type="checkbox" checked={draft.selected} aria-label={`使用 ${model.id || "新模型"}`} onChange={event => onChange({ ...draft, selected: event.target.checked })}/>
      <button type="button" aria-expanded={open} className="jv-model-expand" onClick={() => setOpen(!open)}>
        <span className="jv-row-text"><strong>{model.name || model.id || "新模型"}</strong><span className="jv-mono">{model.id || "填写模型 ID"}</span></span>
        <span className="jv-chips">{model.contextWindow && <span className="jv-chip">{compactTokens(model.contextWindow)}</span>}{model.input.includes("image") && <span className="jv-chip">图片</span>}{model.reasoning && <span className="jv-chip">推理</span>}
          {draft.auto && AUTO_TAGS[draft.auto.status] && <span className="jv-chip jv-chip-warn">{AUTO_TAGS[draft.auto.status]}</span>}</span>
        <ChevronDownIcon className="jv-expand-icon"/>
      </button>
      <Button type="button" variant="ghost" size="icon-sm" className="jv-model-remove" aria-label={`移除 ${model.id || "新模型"}`} onClick={onRemove}><Trash2Icon/></Button>
    </div>
    {open && <div className="jv-model-fields">
      <div className="jv-field-grid">{field("模型 ID", <Input className="jv-mono" required value={model.id} onChange={event => set({ id: event.target.value })} placeholder="model-id"/>)}{field("模型名称", <Input value={model.name} onChange={event => set({ name: event.target.value })} placeholder="可选"/>)}</div>
      <AutoconfigPanel state={draft.auto} modelId={model.id} onRun={onAutoconfig}/>
      <section><h4>能力</h4><div className="flex flex-wrap gap-5"><label className="jarvy-model-check"><input type="checkbox" checked={model.reasoning} onChange={event => set({ reasoning: event.target.checked })}/>推理 / 思考</label><label className="jarvy-model-check"><input type="checkbox" checked={model.input.includes("image")} onChange={event => set({ input: event.target.checked ? ["text", "image"] : ["text"] })}/>图片输入</label></div></section>
      {model.reasoning && <ThinkingSettings model={model} api={model.api || protocol} onChange={set}/>}
      <section><div className="flex items-center justify-between"><h4>模型规格</h4><Button type="button" variant="link" size="sm" onClick={() => setPrices(!prices)}>{prices ? "收起价格" : "编辑价格"}</Button></div>
        <div className="jv-field-grid">{field("上下文窗口 · tokens", <Input type="number" min={1} value={model.contextWindow ?? ""} placeholder="未提供" onChange={event => set({ contextWindow: event.target.value ? Number(event.target.value) : null })}/>)}{field("最大输出 · tokens", <Input type="number" min={1} value={model.maxTokens ?? ""} placeholder="未提供" onChange={event => set({ maxTokens: event.target.value ? Number(event.target.value) : null })}/>)}</div>
        <h4 className="jv-cost-title">每百万 tokens 价格</h4><div className="jv-costs">{([['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入']] as const).map(([key, label]) => <div key={key}><Label>{label}</Label>{prices ? <Input type="number" step="any" min={0} value={model.cost?.[key] ?? ""} onChange={event => set({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...model.cost, [key]: Number(event.target.value) } })}/> : <span>{model.cost?.[key] ?? "未提供"}</span>}</div>)}</div>
      </section>
      <details className="jv-advanced"><summary>高级设置<ChevronDownIcon className="size-4"/></summary>
        <div className="jv-advanced-fields"><div className="jv-field"><span>API override</span><ProtocolSelect allowDefault value={model.api ?? ""} onChange={api => set({ api })}/></div>
          <div className="jv-field"><span>Headers</span>{headers.map((header, index) => <div className="jv-header-row" key={index}>
            <Input className="jv-mono" aria-label="Header Name" placeholder="Header-Name" readOnly={header.saved} value={header.name} onChange={event => setHeader(index, "name", event.target.value)}/>
            <Input aria-label="Header Value" type="password" autoComplete="off" placeholder={header.saved ? "已保存；留空保持" : "value"} value={header.value} onChange={event => setHeader(index, "value", event.target.value)}/>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="移除 Header" onClick={() => { setHeaders(headers.filter((_, i) => i !== index)); if (header.name) set({ headerUpdates: { ...model.headerUpdates, [header.name]: null } }); }}><Trash2Icon/></Button>
          </div>)}<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setHeaders([...headers, { name: "", value: "", saved: false }])}><PlusIcon/>添加 Header</Button></div>
          <CompatField value={model.compat} onChange={compat => set({ compat })}/>
        </div>
      </details>
    </div>}
  </article>;
}
