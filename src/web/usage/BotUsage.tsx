import { useEffect, useState } from "react";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { usageApi, type ModelUsage } from "./api";
import { Button } from "../components/ui/button";
import { DialogHeader, DialogTitle } from "../components/ui/dialog";
import { formatNumber, t } from "../i18n";
import type { Key } from "../i18n/keys";
import "./usage.css";
import { errorText } from "../errors";

type Range = "today" | "7d" | "30d" | "all";
const RANGES: Range[] = ["today", "7d", "30d", "all"];
const rangeLabel = (range: Range) => range === "today" ? t("usage.today") : range === "all" ? t("usage.all") : t("usage.days", { count: range === "7d" ? 7 : 30 });
const METRICS = [["calls", "usage.calls"], ["input", "usage.input"], ["output", "usage.output"], ["cacheRead", "usage.cacheRead"], ["cacheWrite", "usage.cacheWrite"]] as const satisfies readonly (readonly [string, Key])[];
/** Start of the range in the browser's own time zone: today from local midnight, 7 / 30 days including today, and 0 for
 * everything. No History row is before 1970, so 0 needs no special case on the server. */
function since(range: Range): number {
  if (range === "all") return 0;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range === "7d" ? 6 : range === "30d" ? 29 : 0));
  return start.getTime();
}
const count = (value: number) => formatNumber(value, value < 10_000 ? undefined : { notation: "compact", maximumFractionDigits: 1 });
const money = (value: number) => value > 0 && value < 0.01 ? "< $0.01" : `$${value.toFixed(2)}`;

export function BotUsage({ botId, botName, onBack }: { botId: string; botName: string; onBack: () => void }) {
  const [range, setRange] = useState<Range>("today");
  const [models, setModels] = useState<ModelUsage[] | null>(null);
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setModels(null); setError("");
    usageApi.list(botId, since(range)).then(value => { if (active) setModels(value.models); })
      .catch(reason => { if (active) setError(errorText(reason, "usage.loadFailed")); });
    return () => { active = false; };
  }, [botId, range, refresh]);
  const priced = models?.filter(item => item.cost !== null) ?? [];
  const total = models && Object.fromEntries(METRICS.map(([key]) => [key, models.reduce((sum, item) => sum + item[key], 0)])) as Record<(typeof METRICS)[number][0], number>;
  const totalCost = priced.length ? money(priced.reduce((sum, item) => sum + item.cost!, 0)) : t("usage.unpriced");
  return <>
    <DialogHeader className="jv-bot-info-navigation">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("usage.back")} onClick={onBack}><ArrowLeftIcon/></Button>
      <DialogTitle>{t("usage.title")}</DialogTitle>
      <span className="jv-bot-page-name">{botName}</span>
    </DialogHeader>
    <div className="jv-usage">
      <div className="jv-usage-toolbar">
        <div className="jv-tabs" role="tablist" aria-label={t("usage.range")}>
          {RANGES.map(value => <button key={value} type="button" role="tab" aria-selected={range === value} onClick={() => setRange(value)}>{rangeLabel(value)}</button>)}
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={!models && !error} onClick={() => setRefresh(n => n + 1)} aria-label={t("usage.refreshLabel")}><RefreshCwIcon/>{t("usage.refresh")}</Button>
      </div>
      <div className="jv-usage-scroll">
        {error ? <div className="jv-usage-state"><p role="alert">{error}</p><Button variant="outline" size="sm" onClick={() => setRefresh(n => n + 1)}>{t("usage.retry")}</Button></div>
          : !models ? <p className="jv-usage-state" role="status">{t("usage.loading")}</p>
          : !models.length ? <div className="jv-usage-state jv-usage-empty"><p>{t("usage.empty")}</p></div>
          : <>
            <table className="jv-usage-table">
              <thead><tr><th scope="col">{t("usage.model")}</th>{METRICS.map(([key, label]) => <th key={key} scope="col">{t(label)}</th>)}<th scope="col">{t("usage.cost")}</th></tr></thead>
              <tbody>{models.map(item => <tr key={`${item.provider}/${item.model}`}>
                <th scope="row"><span className="jv-usage-model"><strong>{item.model}</strong><span>{item.provider}</span></span></th>
                {METRICS.map(([key, label]) => <td key={key} data-label={t(label)} title={formatNumber(item[key])}>{count(item[key])}</td>)}
                <td data-label={t("usage.cost")} className={item.cost === null ? "jv-usage-unpriced" : undefined} title={item.cost === null ? undefined : `$${item.cost.toFixed(4)}`}>
                  {item.cost === null ? t("usage.unpriced") : money(item.cost)}</td>
              </tr>)}</tbody>
              {models.length > 1 && total && <tfoot><tr>
                <th scope="row"><strong>{t("usage.total")}</strong></th>
                {METRICS.map(([key, label]) => <td key={key} data-label={t(label)} title={formatNumber(total[key])}>{count(total[key])}</td>)}
                <td data-label={t("usage.cost")} className={priced.length ? undefined : "jv-usage-unpriced"}>{totalCost}</td>
              </tr></tfoot>}
            </table>
            {priced.length > 0 && priced.length < models.length && <p className="jv-usage-note">{t("usage.notePartial")}</p>}
          </>}
      </div>
    </div>
  </>;
}
