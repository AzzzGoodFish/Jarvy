import { useEffect, useState } from "react";
import { ArrowLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { api } from "./api";
import { type ProviderOption } from "../contract/models";
import { ProviderMark } from "./ProviderMark";
import { Button } from "./components/ui/button";
import { t } from "./i18n";
import { errorText } from "./errors";

/** Providers and connections are listed in three groups, by how they connect. */
export const GROUPS = [{ id: "custom", label: "group.custom" }, { id: "subscription", label: "group.subscription" }, { id: "api_key", label: "group.apiKey" }] as const;
export type Group = typeof GROUPS[number]["id"];
export const groupOf = (item: { authType: "oauth" | "api_key"; custom: boolean }): Group => item.custom ? "custom" : item.authType === "oauth" ? "subscription" : "api_key";
export type ProviderPreset = Omit<ProviderOption, "group">;
export const CUSTOM: ProviderPreset = { id: "custom", name: "OpenAI / Anthropic compatible", authType: "api_key", api: "openai-completions", modelCount: 0 };
export function ProviderPicker({ onBack, onSelect }: { onBack: () => void; onSelect: (preset: ProviderPreset) => void }) {
  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true; setLoading(true); setError("");
    void api.modelProviders().then(result => { if (alive) setProviders(result.providers); })
      .catch(reason => { if (alive) setError(errorText(reason, "picker.loadFailed")); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  const visible = [CUSTOM, ...providers].filter(item => `${item.name} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  const group = (item: ProviderPreset) => groupOf({ authType: item.authType, custom: item.id === "custom" });
  return <div className="jv-page">
    <header className="jv-page-header"><Button variant="ghost" size="icon-sm" className="jv-back" onClick={onBack} aria-label={t("picker.back")}><ArrowLeftIcon/></Button>
      <h2>{t("models.add")}</h2></header>
    <label className="jv-search"><SearchIcon/><input autoFocus aria-label={t("picker.search")} placeholder={t("picker.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)}/></label>
    {GROUPS.filter(item => visible.some(provider => group(provider) === item.id)).map(({ id, label }) => <section className="jv-section" key={id} aria-label={t(label)}>
      <h3 className="jv-section-title">{t(label)}</h3>
      <div className="jv-list">{visible.filter(item => group(item) === id).map(item => <button className="jv-list-row" type="button" key={`${item.id}:${item.authType}`} onClick={() => onSelect(item)}>
        <ProviderMark name={item.id === "custom" ? "+" : item.name} provider={item.id}/>
        <span className="jv-row-text"><strong>{item.name}</strong>{item.id !== "custom" && item.authType !== "oauth" && <span>{t("picker.keyHint", { count: item.modelCount })}</span>}</span>
        <ChevronRightIcon className="jv-row-chevron"/>
      </button>)}</div>
    </section>)}
    {loading && <p role="status" className="jv-hint">{t("picker.loading")}</p>}
    {error && <div className="jv-empty" role="alert"><strong>{error}</strong><Button variant="outline" onClick={() => setRevision(value => value + 1)}>{t("picker.retry")}</Button></div>}
    {!loading && !error && !visible.length && <div className="jv-empty"><strong>{t("picker.noMatch")}</strong></div>}
  </div>;
}
