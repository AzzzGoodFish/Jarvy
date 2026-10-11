import { BotModelControls } from "./BotModelControls";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import type { Bot, ModelConnection } from "./api";

export function ModelPicker({ bot, connections, onSaved, onManage }: {
  bot: Bot; connections: ModelConnection[]; onSaved: (bot: Bot) => void; onManage: () => void;
}) {
  return <Card className="jarvy-model-picker jv-ui"><CardHeader><CardTitle>为 {bot.name} 选择模型</CardTitle></CardHeader>
    <CardContent><BotModelControls bot={bot} connections={connections} onSaved={onSaved} onManage={onManage}/></CardContent>
  </Card>;
}
