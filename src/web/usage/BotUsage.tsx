import { useEffect, useState } from "react";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { usageApi, type ModelUsage } from "./api";
import { Button } from "../components/ui/button";
import { DialogHeader, DialogTitle } from "../components/ui/dialog";
import "./usage.css";

type Range = "today" | "7d" | "30d";
const RANGES: [Range, string][] = [["today", "今天"], ["7d", "7 天"], ["30d", "30 天"]];
const METRICS = [["calls", "调用"], ["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读"], ["cacheWrite", "缓存写"]] as const;
/** Start of the range in the browser's own time zone: today from local midnight, 7 / 30 days including today. */
function since(range: Range): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range === "7d" ? 6 : range === "30d" ? 29 : 0));
  return start.getTime();
}
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const count = (value: number) => value < 10_000 ? value.toLocaleString("zh-CN") : compact.format(value);
const money = (value: number) => value > 0 && value < 0.01 ? "< $0.01" : `$${value.toFixed(2)}`;

export function BotUsage({ botId, botName, onBack }: { botId: string; botName: string; onBack: () => void }) {
  const [range, setRange] = useState<Range>("today");
  const [models, setModels] = useState<ModelUsage[] | null>(null);
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setModels(null); setError("");
    usageApi.list(botId, since(range)).then(value => { if (active) setModels(value.models); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "用量加载失败"); });
    return () => { active = false; };
  }, [botId, range, refresh]);
  const priced = models?.filter(item => item.cost !== null) ?? [];
  const total = models && Object.fromEntries(METRICS.map(([key]) => [key, models.reduce((sum, item) => sum + item[key], 0)])) as Record<(typeof METRICS)[number][0], number>;
  const totalCost = priced.length ? money(priced.reduce((sum, item) => sum + item.cost!, 0)) : "未配置价格";
  return <>
    <DialogHeader className="jv-bot-info-navigation">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="返回 Bot 信息" onClick={onBack}><ArrowLeftIcon/></Button>
      <DialogTitle>用量</DialogTitle>
      <span className="jv-bot-page-name">{botName}</span>
    </DialogHeader>
    <div className="jv-usage">
      <div className="jv-usage-toolbar">
        <div className="jv-tabs" role="tablist" aria-label="时间范围">
          {RANGES.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={range === value} onClick={() => setRange(value)}>{label}</button>)}
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={!models && !error} onClick={() => setRefresh(n => n + 1)} aria-label="刷新用量"><RefreshCwIcon/>刷新</Button>
      </div>
      <div className="jv-usage-scroll">
        {error ? <div className="jv-usage-state"><p role="alert">{error}</p><Button variant="outline" size="sm" onClick={() => setRefresh(n => n + 1)}>重试</Button></div>
          : !models ? <p className="jv-usage-state" role="status">读取用量…</p>
          : !models.length ? <div className="jv-usage-state jv-usage-empty"><p>这段时间没有模型调用</p></div>
          : <>
            <table className="jv-usage-table">
              <thead><tr><th scope="col">模型</th>{METRICS.map(([key, label]) => <th key={key} scope="col">{label}</th>)}<th scope="col">费用</th></tr></thead>
              <tbody>{models.map(item => <tr key={`${item.provider}/${item.model}`}>
                <th scope="row"><span className="jv-usage-model"><strong>{item.model}</strong><span>{item.provider}</span></span></th>
                {METRICS.map(([key, label]) => <td key={key} data-label={label} title={item[key].toLocaleString("zh-CN")}>{count(item[key])}</td>)}
                <td data-label="费用" className={item.cost === null ? "jv-usage-unpriced" : undefined} title={item.cost === null ? undefined : `$${item.cost.toFixed(4)}`}>
                  {item.cost === null ? "未配置价格" : money(item.cost)}</td>
              </tr>)}</tbody>
              {models.length > 1 && total && <tfoot><tr>
                <th scope="row"><strong>合计</strong></th>
                {METRICS.map(([key, label]) => <td key={key} data-label={label} title={total[key].toLocaleString("zh-CN")}>{count(total[key])}</td>)}
                <td data-label="费用" className={priced.length ? undefined : "jv-usage-unpriced"}>{totalCost}</td>
              </tr></tfoot>}
            </table>
            <p className="jv-usage-note">输入、输出和缓存的单位是 token{priced.length > 0 && priced.length < models.length ? "；合计费用不含未配置价格的模型" : ""}。</p>
          </>}
      </div>
    </div>
  </>;
}
