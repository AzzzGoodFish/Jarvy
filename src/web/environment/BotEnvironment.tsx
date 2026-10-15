import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { api, type Bot, type EnvironmentKind } from "../api";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { errorText } from "../errors";
import "../styles/environment.css";

const STATE = {
  preparing: ["environment.state.preparing", "environment.hint.preparing"],
  running: ["environment.state.running", "environment.hint.running"],
  stopped: ["environment.state.stopped", "environment.hint.stopped"],
  failed: ["environment.state.failed", "environment.hint.failed"],
  unavailable: ["environment.state.unavailable", "environment.hint.unavailable"],
} as const;

/** Where a Bot's file and command tools run (A50): its own computer, or the owner's. A change applies from the Bot's
 * next command. Used in Bot info and in a new Bot's first setup. */
export function EnvironmentChoice({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { home, docker } = bot.environment;
  async function pick(kind: EnvironmentKind) {
    if (kind === home || busy) return;
    setBusy(true); setError("");
    try { onSaved(await api.setBotEnvironment(bot.id, kind)); }
    catch (reason) { setError(errorText(reason, "environment.changeFailed")); }
    finally { setBusy(false); }
  }
  const option = (kind: EnvironmentKind, title: string, hint: string, disabled: boolean) =>
    <button key={kind} type="button" role="radio" aria-checked={home === kind} disabled={busy || disabled} className="jv-list-row jv-choice-row jv-env-option" onClick={() => void pick(kind)}>
      <span className="jv-row-text"><strong>{title}</strong><span>{hint}</span></span>{home === kind && <CheckIcon aria-hidden="true"/>}</button>;
  return <>
    <div className="jv-list" role="radiogroup" aria-label={t("environment.title")}>
      {option("computer", t("environment.computer"), t(docker ? "environment.computerHint" : "environment.noDocker"), !docker)}
      {option("host", t("environment.host"), t("environment.hostHint"), false)}
    </div>
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </>;
}

/** Bot info's section: the choice, then its own computer's state with start, stop and reset when it has one. */
export function BotEnvironment({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const [action, setAction] = useState<"start" | "stop" | "reset" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const computer = bot.environment.computer;
  async function run(what: "start" | "stop" | "reset") {
    setAction(what); setError("");
    try { onSaved(await api.computer(bot.id, what)); }
    catch (reason) { setError(errorText(reason, "common.failed")); }
    finally { setAction(null); }
  }
  const state = computer?.state;
  const [label, hint] = state ? STATE[state] : [null, null];
  return <section className="jv-section" aria-label={t("environment.title")}><h3 className="jv-section-title">{t("environment.title")}</h3>
    <EnvironmentChoice bot={bot} onSaved={onSaved}/>
    {state && label && hint && <div className="jv-list jv-env-computer">
      <div className="jv-list-row jv-static-row">
        <span className="jv-row-text"><strong>{t("environment.its")}</strong><span>{t(hint)}</span></span>
        <span className="jv-status" data-ok={state === "running" || undefined} data-busy={state === "preparing" || undefined}>{t(label)}</span>
        {state !== "unavailable" && <>
          <Button type="button" variant="outline" size="sm" disabled={!!action || state === "preparing"} onClick={() => void run(state === "running" ? "stop" : "start")}>
            {t(action === "start" ? "environment.starting" : action === "stop" ? "environment.stopping" : state === "running" ? "environment.stop" : "environment.start")}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={!!action || state === "preparing" || confirming} onClick={() => setConfirming(true)}>{t("environment.reset")}</Button>
        </>}
      </div>
    </div>}
    {/* Asked in place: Bot info is itself a dialog. */}
    {confirming && <div className="jv-env-confirm" role="group" aria-label={t("environment.resetTitle", { name: bot.name })}>
      <strong>{t("environment.resetTitle", { name: bot.name })}</strong><p>{t("environment.resetBody")}</p>
      <div className="jv-env-confirm-actions"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
        <Button type="button" className="jv-primary" size="sm" onClick={() => { setConfirming(false); void run("reset"); }}>{t("environment.resetConfirm")}</Button></div>
    </div>}
    <p className="jv-hint jv-env-note">{t("environment.moveHint")}</p>
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
