import { ArrowLeftIcon } from "lucide-react";
import { usageApi } from "./api";
import { ModelTable, UsageState, UsageToolbar, useUsage } from "./parts";
import { Button } from "../components/ui/button";
import { DialogHeader, DialogTitle } from "../components/ui/dialog";
import { t } from "../i18n";
import "./usage.css";

/** Bot info → 用量: one Bot's token use and cost per model (A46). */
export function BotUsage({ botId, botName, onBack }: { botId: string; botName: string; onBack: () => void }) {
  const { range, setRange, data, error, reload } = useUsage(since => usageApi.list(botId, since).then(value => value.models), botId);
  return <>
    <DialogHeader className="jv-bot-info-navigation">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("usage.back")} onClick={onBack}><ArrowLeftIcon/></Button>
      <DialogTitle>{t("usage.title")}</DialogTitle>
      <span className="jv-bot-page-name">{botName}</span>
    </DialogHeader>
    <div className="jv-usage">
      <UsageToolbar range={range} setRange={setRange} busy={!data && !error} reload={reload}/>
      <div className="jv-usage-scroll">
        <UsageState loading={!data} error={error} empty={!data?.length} reload={reload}/>
        {data && data.length > 0 && !error && <ModelTable models={data}/>}
      </div>
    </div>
  </>;
}
