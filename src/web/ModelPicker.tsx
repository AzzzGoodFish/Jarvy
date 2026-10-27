import { BotModelControls } from "./BotModelControls";
import { EnvironmentChoice } from "./environment/BotEnvironment";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import type { Bot } from "../contract/bots";
import type { ModelConnection } from "../contract/models";
import { t } from "./i18n";

export function ModelPicker({ bot, connections, onSaved, onManage }: {
  bot: Bot; connections: ModelConnection[]; onSaved: (bot: Bot) => void; onManage: () => void;
}) {
  return <Card className="jarvy-model-picker jv-ui"><CardHeader><CardTitle>{t("botModel.pickFor", { name: bot.name })}</CardTitle></CardHeader>
    <CardContent><BotModelControls bot={bot} connections={connections} onSaved={onSaved} onManage={onManage}/>
      {/* A new Bot's other first choice (A50): where it works. */}
      <div className="jv-env-setup"><h4>{t("environment.title")}</h4><EnvironmentChoice bot={bot} onSaved={onSaved}/></div></CardContent>
  </Card>;
}
