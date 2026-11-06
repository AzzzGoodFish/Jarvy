import { usageApi } from "./api";
import { ModelTable, UsageState, UsageToolbar, useUsage } from "./parts";
import "./usage.css";

/** Bot info → 用量: one Bot's token use and cost per model (A46). */
export function BotUsage({ botId }: { botId: string }) {
  const { range, setRange, data, error, reload } = useUsage(since => usageApi.list(botId, since).then(value => value.models), botId);
  return <div className="jv-usage">
    <UsageToolbar range={range} setRange={setRange} busy={!data && !error} reload={reload}/>
    <div className="jv-usage-scroll">
      <UsageState loading={!data} error={error} empty={!data?.length} reload={reload}/>
      {data && data.length > 0 && !error && <ModelTable models={data}/>}
    </div>
  </div>;
}
