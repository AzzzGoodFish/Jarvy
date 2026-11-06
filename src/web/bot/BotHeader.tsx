import { useState } from "react";
import { type Bot, type BotStatus } from "../../contract/bots";
import { type BotColor } from "../../contract/models";
import { api } from "../api";
import { BotAvatar } from "../avatar/BotAvatar";
import { BOT_COLORS, colorHex } from "../avatar/palette";
import { Button } from "../components/ui/button";
import { DialogTitle } from "../components/ui/dialog";
import { errorText } from "../errors";
import { t } from "../i18n";

const STATUS_LABEL = { running: "activity.running", idle: "activity.idle", stop: "activity.stopped" } as const;

/** Bot info's fixed top (A83): who the Bot is and its colour on the left, whether it runs and the switch for it on the
 * right, so both stay in view whichever tab is open. */
export function BotHeader({ bot, status, onSaved }: { bot: Bot; status?: BotStatus; onSaved: (bot: Bot) => void }) {
  const [control, setControl] = useState<"start" | "stop" | "abort" | null>(null);
  const [coloring, setColoring] = useState(false);
  const [error, setError] = useState("");
  const runtime = status?.status ?? "stop";
  async function controlRuntime(action: "start" | "stop" | "abort") {
    setControl(action); setError("");
    try { await api.controlBot(bot.id, action); }
    catch (reason) { setError(errorText(reason, "common.failed")); }
    finally { setControl(null); }
  }
  async function changeColor(color: BotColor) {
    if (color === bot.color) return;
    setColoring(true); setError("");
    try { onSaved(await api.setBotColor(bot.id, color)); }
    catch (reason) { setError(errorText(reason, "bot.changeFailed")); }
    finally { setColoring(false); }
  }
  return <header className="jv-bot-head">
    <BotAvatar color={bot.color} mood={bot.mood} size={56} crown={bot.agent}/>
    <div className="jv-bot-identity">
      <DialogTitle>{bot.name}</DialogTitle>
      {bot.description && <span>{bot.description}</span>}
      <div className="jv-bot-colors" role="radiogroup" aria-label={t("bot.color")}>
        {(Object.keys(BOT_COLORS) as BotColor[]).map(color => <button key={color} type="button" role="radio" aria-checked={bot.color === color}
          aria-label={t(BOT_COLORS[color].label)} title={t(BOT_COLORS[color].label)} disabled={coloring} style={{ background: colorHex(color) }} onClick={() => void changeColor(color)}/>)}
      </div>
    </div>
    <div className="jv-bot-run">
      <span className="jv-status" data-ok={runtime !== "stop" || undefined} data-busy={runtime === "running" || undefined}>{t(STATUS_LABEL[runtime])}</span>
      {runtime === "running" && <Button type="button" variant="ghost" size="sm" disabled={!!control} onClick={() => void controlRuntime("abort")}>{t(control === "abort" ? "bot.aborting" : "bot.abort")}</Button>}
      <Button type="button" variant="outline" size="sm" disabled={!!control || !bot.connectionId} onClick={() => void controlRuntime(runtime === "stop" ? "start" : "stop")}>
        {t(control === "start" ? "bot.starting" : control === "stop" ? "bot.stopping" : runtime === "stop" ? "bot.start" : "bot.stop")}</Button>
    </div>
    {error && <p className="jv-note-error jv-bot-head-error" role="alert">{error}</p>}
  </header>;
}
