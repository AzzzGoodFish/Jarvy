import { useEffect, useState } from "react";
import { ArrowLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { api, type ProviderOption } from "./api";
import { ProviderMark } from "./ProviderMark";
import { Button } from "./components/ui/button";

export type ProviderPreset = Omit<ProviderOption, "group"> & { group: "自定义 API" | "订阅服务" | "API Key" };
export const CUSTOM: ProviderPreset = { id: "custom", name: "OpenAI / Anthropic compatible", group: "自定义 API", authType: "api_key", api: "openai-completions", modelCount: 0 };
export const GROUPS = ["自定义 API", "订阅服务", "API Key"] as const;
export function ProviderPicker({ onBack, onSelect }: { onBack: () => void; onSelect: (preset: ProviderPreset) => void }) {
  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true; setLoading(true); setError("");
    void api.modelProviders().then(result => { if (alive) setProviders(result.providers); })
      .catch(reason => { if (alive) setError(reason.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  const visible = [CUSTOM, ...providers].filter(item => `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="jv-page">
    <header className="jv-page-header"><Button variant="ghost" size="icon-sm" className="jv-back" onClick={onBack} aria-label="返回模型页面"><ArrowLeftIcon/></Button>
      <div><h2>添加 Provider</h2><p>选择服务类型，下一步填写凭证与模型。</p></div></header>
    <label className="jv-search"><SearchIcon/><input autoFocus aria-label="搜索 Provider" placeholder="搜索 Provider…" value={query} onChange={event => setQuery(event.target.value)}/></label>
    {GROUPS.filter(group => visible.some(item => item.group === group)).map(group => <section className="jv-section" key={group} aria-label={group}>
      <h3 className="jv-section-title">{group}</h3>
      <div className="jv-list">{visible.filter(item => item.group === group).map(item => <button className="jv-list-row" type="button" key={`${item.id}:${item.authType}`} onClick={() => onSelect(item)}>
        <ProviderMark name={item.id === "custom" ? "+" : item.name}/>
        <span className="jv-row-text"><strong>{item.name}</strong><span>{item.id === "custom" ? "任意 OpenAI / Anthropic / Gemini 兼容端点" : item.authType === "oauth" ? "账号登录" : `API Key · ${item.modelCount} 个模型`}</span></span>
        <ChevronRightIcon className="jv-row-chevron"/>
      </button>)}</div>
    </section>)}
    {loading && <p role="status" className="jv-hint">正在读取 Provider…</p>}
    {error && <div className="jv-empty" role="alert"><strong>{error}</strong><Button variant="outline" onClick={() => setRevision(value => value + 1)}>重试</Button></div>}
    {!loading && !error && !visible.length && <div className="jv-empty"><strong>没有匹配的 Provider</strong><span>换个关键词试试。</span></div>}
  </div>;
}
