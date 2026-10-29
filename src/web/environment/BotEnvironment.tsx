import { useState } from "react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { t, type Key } from "../i18n";
import { Button } from "../components/ui/button";
import { useAction } from "../action";
import "../styles/environment.css";

const STATE = {
  preparing: ["environment.state.preparing", "environment.hint.preparing"],
  running: ["environment.state.running", "environment.hint.running"],
  stopped: ["environment.state.stopped", "environment.hint.stopped"],
  failed: ["environment.state.failed", "environment.hint.failed"],
  unavailable: ["environment.state.unavailable", "environment.hint.unavailable"],
} as const;

/** Bot info's section (A50, A67), in two parts. Its Docker sandbox, the only default there is: what it is, its state,
 * the container, image and mount it is made of, Start or Stop and Reset, and where the Bot is when it switched to a
 * machine. Then the external environments it may switch to, the SSH machines (A57), each with a switch. */
export function BotEnvironment({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const { doing: busy, error, run: perform } = useAction<"grant" | "start" | "stop" | "reset">();
  /** Stopping and resetting are destructive: both ask in place first. */
  const [confirming, setConfirming] = useState<"stop" | "reset" | null>(null);
  const { computer, current, currentName, machines = [] } = bot.environment;
  const act = (what: NonNullable<typeof busy>, work: () => Promise<Bot>, fallback: Key) => perform(what, async () => onSaved(await work()), fallback);
  const run = (what: "start" | "stop" | "reset") => void act(what, () => api.computer(bot.id, what), "common.failed");
  const state = computer?.state;
  const [label, hint] = state ? STATE[state] : [null, null];
  return <section className="jv-section" aria-label={t("environment.title")}><h3 className="jv-section-title">{t("environment.title")}</h3>
    {computer && state && label && hint && <div className="jv-list jv-env-sandbox">
      <div className="jv-list-row jv-static-row">
        <span className="jv-row-text"><strong>{t("environment.own")}</strong><span>{t("environment.sandboxAbout")}</span>
          {current === "ssh" && <span className="jv-env-away">{t("environment.awayMachine", { name: currentName ?? "" })}</span>}</span>
        <span className="jv-status" data-ok={state === "running" || undefined} data-busy={state === "preparing" || undefined}>{t(label)}</span>
      </div>
      <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("environment.container")}</span><code>{computer.container}</code></div>
      <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("environment.image")}</span><code>{computer.image}</code></div>
      <div className="jv-list-row jv-static-row jv-env-fact"><span>{t("environment.mount")}</span><code>{computer.mount}</code></div>
      <div className="jv-list-row jv-static-row jv-env-details">
        <p>{t(hint)}</p>
        {state !== "unavailable" && !confirming && <div className="jv-env-actions">
          <Button type="button" variant="outline" size="sm" disabled={!!busy || state === "preparing"} onClick={() => state === "running" ? setConfirming("stop") : run("start")}>
            {t(busy === "start" ? "environment.starting" : busy === "stop" ? "environment.stopping" : state === "running" ? "environment.stop" : "environment.start")}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={!!busy || state === "preparing"} onClick={() => setConfirming("reset")}>{t("environment.reset")}</Button>
        </div>}
        {/* Asked in place: Bot info is itself a dialog. */}
        {confirming && <div className="jv-env-confirm" role="group" aria-label={t(`environment.${confirming}Title`, { name: bot.name })}>
          <strong>{t(`environment.${confirming}Title`, { name: bot.name })}</strong><p>{t(`environment.${confirming}Body`)}</p>
          <div className="jv-env-confirm-actions"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>{t("common.cancel")}</Button>
            <Button type="button" className="jv-primary" size="sm" onClick={() => { const what = confirming; setConfirming(null); run(what); }}>{t(`environment.${confirming}Confirm`)}</Button></div>
        </div>}
      </div>
    </div>}
    <h4 className="jv-env-heading">{t("environment.external")}</h4>
    <div className="jv-list" role="group" aria-label={t("environment.external")}>
      {machines.length === 0 && <div className="jv-list-row jv-static-row"><span className="jv-row-text"><span>{t("environment.noMachines")}</span></span></div>}
      {machines.map(machine => <button key={machine.id} type="button" role="switch" aria-checked={machine.granted} disabled={!!busy} className="jv-list-row jv-choice-row jv-env-access"
        onClick={() => void act("grant", () => api.grantBotMachine(bot.id, machine.id, !machine.granted), "environment.accessFailed")}>
        <span className="jv-row-text"><strong>{machine.name}</strong></span>
        <span className="jv-env-switch" aria-hidden="true"/>
      </button>)}
    </div>
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
