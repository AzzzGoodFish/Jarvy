import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import type { ModelUsage } from "../../contract/usage";
import { Button } from "../components/ui/button";
import { formatNumber, t } from "../i18n";
import type { Key } from "../i18n/keys";
import { errorText } from "../errors";

/** What one Bot's usage page and the usage of every Bot in Settings share (A46, A81): the period, loading it, and the
 * per-model table. */
export type Range = "today" | "7d" | "30d" | "all";
const RANGES: Range[] = ["today", "7d", "30d", "all"];
const rangeLabel = (range: Range) => range === "today" ? t("usage.today") : range === "all" ? t("usage.all") : t("usage.days", { count: range === "7d" ? 7 : 30 });
export const METRICS = [["calls", "usage.calls"], ["input", "usage.input"], ["output", "usage.output"], ["cacheRead", "usage.cacheRead"], ["cacheWrite", "usage.cacheWrite"]] as const satisfies readonly (readonly [string, Key])[];
export type Metric = (typeof METRICS)[number][0];

/** Start of the range in the browser's own time zone: today from local midnight, 7 / 30 days including today, and 0 for
 * everything. No History row is before 1970, so 0 needs no special case on the server. */
function since(range: Range): number {
  if (range === "all") return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range === "7d" ? 6 : range === "30d" ? 29 : 0));
  return start.getTime();
}
export const count = (value: number) => formatNumber(value, value < 10_000 ? undefined : { notation: "compact", maximumFractionDigits: 1 });
export const money = (value: number) => value > 0 && value < 0.01 ? "< $0.01" : `$${value.toFixed(2)}`;
/** A cost cell: the amount, or 「未设置价格」 when nothing in it was priced. */
export const costCell = (cost: number | null) => <td data-label={t("usage.cost")} className={cost === null ? "jv-usage-unpriced" : undefined}
  title={cost === null ? undefined : `$${cost.toFixed(4)}`}>{cost === null ? t("usage.unpriced") : money(cost)}</td>;

/** The period picked, and what was loaded for it: null while loading. Changing the period or refreshing loads again. */
export function useUsage<T>(load: (since: number) => Promise<T>, key: string) {
  const [range, setRange] = useState<Range>("today");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null); setError("");
    load(since(range)).then(value => { if (active) setData(value); })
      .catch(reason => { if (active) setError(errorText(reason, "usage.loadFailed")); });
    return () => { active = false; };
    // `load` is a new function each render; `key` says what it loads.
  }, [key, range, refresh]);
  return { range, setRange, data, error, reload: () => setRefresh(n => n + 1) };
}

/** The period tabs and the refresh button. */
export function UsageToolbar({ range, setRange, busy, reload }: { range: Range; setRange: (range: Range) => void; busy: boolean; reload: () => void }) {
  return <div className="jv-usage-toolbar">
    <div className="jv-tabs" role="tablist" aria-label={t("usage.range")}>
      {RANGES.map(value => <button key={value} type="button" role="tab" aria-selected={range === value} onClick={() => setRange(value)}>{rangeLabel(value)}</button>)}
    </div>
    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={reload} aria-label={t("usage.refreshLabel")}><RefreshCwIcon/>{t("usage.refresh")}</Button>
  </div>;
}

/** Loading, a failure with a retry, or nothing in the period; null once there is something to show. */
export function UsageState({ loading, error, empty, reload }: { loading: boolean; error: string; empty: boolean; reload: () => void }) {
  if (error) return <div className="jv-usage-state"><p role="alert">{error}</p><Button variant="outline" size="sm" onClick={reload}>{t("usage.retry")}</Button></div>;
  if (loading) return <p className="jv-usage-state" role="status">{t("usage.loading")}</p>;
  if (empty) return <div className="jv-usage-state jv-usage-empty"><p>{t("usage.empty")}</p></div>;
  return null;
}

/** One row per provider and model, with a total below when there is more than one; the total's cost leaves out models
 * with no price. */
export function ModelTable({ models, note = true }: { models: ModelUsage[]; note?: boolean }) {
  const priced = models.filter(item => item.cost !== null);
  const total = Object.fromEntries(METRICS.map(([key]) => [key, models.reduce((sum, item) => sum + item[key], 0)])) as Record<Metric, number>;
  return <>
    <table className="jv-usage-table">
      <thead><tr><th scope="col">{t("usage.model")}</th>{METRICS.map(([key, name]) => <th key={key} scope="col">{t(name)}</th>)}<th scope="col">{t("usage.cost")}</th></tr></thead>
      <tbody>{models.map(item => <tr key={`${item.provider}/${item.model}`}>
        <th scope="row"><span className="jv-usage-model"><strong>{item.model}</strong><span>{item.provider}</span></span></th>
        {METRICS.map(([key, name]) => <td key={key} data-label={t(name)} title={formatNumber(item[key])}>{count(item[key])}</td>)}
        {costCell(item.cost)}
      </tr>)}</tbody>
      {models.length > 1 && <tfoot><tr>
        <th scope="row"><strong>{t("usage.total")}</strong></th>
        {METRICS.map(([key, name]) => <td key={key} data-label={t(name)} title={formatNumber(total[key])}>{count(total[key])}</td>)}
        {costCell(priced.length ? priced.reduce((sum, item) => sum + item.cost!, 0) : null)}
      </tr></tfoot>}
    </table>
    {note && priced.length > 0 && priced.length < models.length && <p className="jv-usage-note">{t("usage.notePartial")}</p>}
  </>;
}
