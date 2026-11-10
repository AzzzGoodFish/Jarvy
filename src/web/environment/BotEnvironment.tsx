import { useState } from "react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import type { DockerProblemReason } from "../../contract/environment";
import { t, type Key } from "../i18n";
import { Button } from "../components/ui/button";
import { useAction } from "../action";
import { SandboxLimits } from "./SandboxLimits";
import { SandboxType } from "./SandboxType";
import "../styles/environment.css";

/** A sandbox's state, in words. */
export const STATE = {
  preparing: "environment.state.preparing", running: "environment.state.running", stopped: "environment.state.stopped",
  failed: "environment.state.failed", unavailable: "environment.state.unavailable",
} as const;

/** Why Docker can't be used, as the server tells it; an older server says nothing. */
const unusable = (error: string | undefined): DockerProblemReason =>
  error === "missing" || error === "stopped" || error === "denied" ? error : "failed";

/** Bot info's section (A50, A68): its Docker sandbox, the only default there is: its state, its type (container or VM,
 * A85), the container, image and mount it is made of, its resource limits or a VM's size and usage (A75), Start or Stop
 * and Reset — and Restart when a VM's new size waits for it — and where the Bot is when it switched to a machine. The
 * machines it may use are on the 授权 tab (BotAccess). */
export function BotEnvironment({ bot, onSaved, heading = true }: { bot: Bot; onSaved: (bot: Bot) => void;
  /** Off on the Environments page, whose header already names the sandbox (A89). */
  heading?: boolean;
}) {
  const { doing: busy, error, run: perform } = useAction<"start" | "stop" | "reset" | "restart">();
  /** Stopping, restarting and resetting are destructive: each asks in place first. */
  const [confirming, setConfirming] = useState<"stop" | "reset" | "restart" | null>(null);
  const { computer, current, currentName } = bot.environment;
  const act = (what: NonNullable<typeof busy>, work: () => Promise<Bot>, fallback: Key) => perform(what, async () => onSaved(await work()), fallback);
  const run = (what: "start" | "stop" | "reset" | "restart") => void act(what, () => api.computer(bot.id, what), "common.failed");
  const state = computer?.state, vm = computer?.type === "vm";
  const label = state ? STATE[state] : null;
  return <section className="jv-section" aria-label={t("environment.title")}>{heading && <h3 className="jv-section-title">{t("environment.title")}</h3>}
    {computer && state && label && <div className="jv-list jv-env-sandbox">
      <div className="jv-list-row jv-static-row">
        <span className="jv-row-text"><strong>{t("environment.own")}</strong>
          {current === "ssh" && <span className="jv-env-away">{t("environment.awayMachine", { name: currentName ?? "" })}</span>}</span>
        <span className="jv-status" data-ok={state === "running" || undefined} data-busy={state === "preparing" || undefined}>{t(label)}</span>
      </div>
      {state !== "unavailable" && <SandboxType bot={bot} disabled={!!busy || state === "preparing"} onSaved={onSaved}/>}
      <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("environment.container")}</span><code>{computer.container}</code></div>
      <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("environment.image")}</span><code>{computer.image}</code></div>
      <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("environment.mount")}</span><code>{computer.mount}</code></div>
      {state !== "unavailable" && <SandboxLimits bot={bot} onSaved={onSaved}/>}
      <div className="jv-list-row jv-static-row jv-env-details">
        {/* The state says the rest; only Docker that can't be used needs words: why, and what that stops. The agent Bot
          * helps fix it (its setup skill). */}
        {computer.restartNeeded && state === "running" && !confirming && <p>{t("environment.restartNote")}</p>}
        {state === "unavailable" ? <p>{t("environment.unavailable", { why: t(`environment.unavailable.${unusable(computer.error)}`) })}</p> : !confirming && <div className="jv-env-actions">
          {computer.restartNeeded && state === "running" && <Button type="button" className="jv-primary" size="sm" disabled={!!busy} onClick={() => setConfirming("restart")}>{t("environment.restart")}</Button>}
          <Button type="button" variant="outline" size="sm" disabled={!!busy || state === "preparing"} onClick={() => state === "running" ? setConfirming("stop") : run("start")}>
            {t(busy === "start" ? "environment.starting" : busy === "stop" ? "environment.stopping" : state === "running" ? "environment.stop" : "environment.start")}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={!!busy || state === "preparing"} onClick={() => setConfirming("reset")}>{t("environment.reset")}</Button>
        </div>}
        {/* Asked in place: Bot info is itself a dialog. */}
        {confirming && <div className="jv-env-confirm" role="group" aria-label={t(`environment.${confirming}Title`, { name: bot.name })}>
          <strong>{t(`environment.${confirming}Title`, { name: bot.name })}</strong><p>{t(confirming === "reset" && vm ? "environment.resetBodyVm" : `environment.${confirming}Body`)}</p>
          <div className="jv-env-confirm-actions"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>{t("common.cancel")}</Button>
            <Button type="button" className="jv-primary" size="sm" onClick={() => { const what = confirming; setConfirming(null); run(what); }}>{t(`environment.${confirming}Confirm`)}</Button></div>
        </div>}
      </div>
    </div>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
