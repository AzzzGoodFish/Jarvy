import { SparklesIcon } from "lucide-react";
import { api, type AutoconfigResult, type AutoconfigSource, type ConfiguredModel } from "./api";
import { Button } from "./components/ui/button";

/** Last autoconfigure outcome for a draft card; UI-only, never saved (no provenance storage). */
type Matched = Extract<AutoconfigResult, { status: "matched" }>;
export type AutoState = Exclude<AutoconfigResult, Matched> | Omit<Matched, "fields"> | { status: "error"; message: string } | { status: "pending" };
export interface AutoDraft { model: ConfiguredModel; auto?: AutoState; }

export type AutoOutcome = AutoconfigResult | { status: "error"; message: string };
/** One catalog lookup for the draft's current ID and effective protocol. */
export async function requestAutoconfig(model: ConfiguredModel, protocol: string, choice?: { provider: string; modelId: string }): Promise<AutoOutcome> {
  try { return await api.autoconfigModel({ modelId: model.id, api: model.api || protocol, ...(choice ? { choice } : {}) }); }
  catch (reason) { return { status: "error", message: reason instanceof Error ? reason.message : "自动配置失败" }; }
}
/** Applies suggested fields to the draft (unsaved); ID, headers and API override stay the user's. */
export function applyAutoconfig<T extends AutoDraft>(draft: T, outcome: AutoOutcome): T {
  if (outcome.status !== "matched") return { ...draft, auto: outcome };
  const { fields, ...auto } = outcome;
  const keepName = draft.model.name && draft.model.name !== draft.model.id;
  return { ...draft, model: { ...draft.model, ...fields, name: keepName ? draft.model.name : outcome.source.name || draft.model.id }, auto };
}

const label = (source: AutoconfigSource) => `${source.provider} / ${source.modelId}`;
function Sources({ items, onPick }: { items: AutoconfigSource[]; onPick: (source: AutoconfigSource) => void }) {
  return <div className="jv-auto-sources">{items.map(item => <button type="button" key={`${item.provider}/${item.modelId}`} onClick={() => onPick(item)}>
    <span className="jv-mono">{label(item)}</span>{item.official && <em>原厂</em>}<small>{item.api}</small>
  </button>)}</div>;
}

export function AutoconfigPanel({ state, modelId, onRun }: { state?: AutoState; modelId: string; onRun: (choice?: { provider: string; modelId: string }) => void }) {
  const pick = (source: AutoconfigSource) => onRun({ provider: source.provider, modelId: source.modelId });
  const busy = state?.status === "pending";
  return <div className="jv-autoconfig" aria-live="polite">
    <Button type="button" variant="outline" size="sm" disabled={!modelId.trim() || busy} onClick={() => onRun()}><SparklesIcon/>{busy ? "配置中…" : "自动配置"}</Button>
    {state && !busy && <div className="jv-auto-result">
      {state.status === "matched" && <>
        <p>已按 <strong className="jv-mono">{label(state.source)}</strong> 填入配置{state.reseller ? "（来自转售目录，非原厂）" : ""}；保存后生效。</p>
        {state.apiMismatch && <p className="jv-auto-warn">目录中此模型使用 {state.source.api} 协议，与当前协议不同，思考格式和兼容参数未填入。</p>}
        {state.alternatives.length > 0 && <details><summary>更换来源</summary><Sources items={state.alternatives} onPick={pick}/></details>}
      </>}
      {state.status === "choose" && <><p>{state.reason === "multiple" ? "同名模型有多个原厂来源，请选择：" : `目录中没有 ${modelId}，以下是相似模型：`}</p><Sources items={state.options} onPick={pick}/></>}
      {state.status === "none" && <p>目录中没有找到此模型，请手动填写。</p>}
      {state.status === "error" && <p role="alert">{state.message}</p>}
    </div>}
  </div>;
}
