import type { Bot } from "../../contract/bots";
import type { BotUsage } from "../../contract/usage";
import { BotAvatar } from "../avatar/BotAvatar";
import { formatNumber, t } from "../i18n";
import { usageApi } from "./api";
import { ModelTable, UsageState, UsageToolbar, costCell, count, useUsage } from "./parts";
import "./usage.css";

const BOT_METRICS = [["calls", "usage.calls"], ["input", "usage.input"], ["output", "usage.output"]] as const;

/** Settings → 用量: every Bot's token use and cost (A81), per model across Bots and per Bot across models. */
export function AllUsage({ bots }: { bots: Bot[] }) {
  const { range, setRange, data, error, reload } = useUsage(usageApi.overview, "all");
  return <div className="jv-page jv-usage-page">
    <header className="jv-page-header"><h2>{t("settings.usage")}</h2></header>
    <div className="jv-usage">
      <UsageToolbar range={range} setRange={setRange} busy={!data && !error} reload={reload}/>
      <UsageState loading={!data} error={error} empty={!data?.models.length} reload={reload}/>
      {data && data.models.length > 0 && !error && <>
        <section className="jv-section" aria-labelledby="usage-models"><h3 id="usage-models" className="jv-section-title">{t("usage.byModel")}</h3>
          <ModelTable models={data.models} note={false}/></section>
        <section className="jv-section" aria-labelledby="usage-bots"><h3 id="usage-bots" className="jv-section-title">{t("usage.byBot")}</h3>
          <BotTable rows={data.bots} bots={bots}/></section>
        {data.models.some(item => item.cost === null) && data.models.some(item => item.cost !== null) && <p className="jv-usage-note">{t("usage.noteCosts")}</p>}
      </>}
    </div>
  </div>;
}

/** One row per Bot that called a model in the period, most expensive first. */
function BotTable({ rows, bots }: { rows: BotUsage[]; bots: Bot[] }) {
  return <table className="jv-usage-table jv-usage-bots">
    <thead><tr><th scope="col">Bot</th>{BOT_METRICS.map(([key, name]) => <th key={key} scope="col">{t(name)}</th>)}<th scope="col">{t("usage.cost")}</th></tr></thead>
    <tbody>{rows.map(row => {
      const bot = bots.find(item => item.id === row.botId);
      return <tr key={row.botId}>
        <th scope="row"><span className="jv-usage-bot">{bot && <BotAvatar color={bot.color} mood={bot.mood} size={22}/>}<strong>{bot?.name ?? row.botId}</strong></span></th>
        {BOT_METRICS.map(([key, name]) => <td key={key} data-label={t(name)} title={formatNumber(row[key])}>{count(row[key])}</td>)}
        {costCell(row.cost)}
      </tr>;
    })}</tbody>
  </table>;
}
