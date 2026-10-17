import { useId, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
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

/** Where a Bot's file and command tools run (A50): its sandbox, or the owner's. A change applies from the Bot's
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

/** Bot info's section (A50, fish m1046), in two parts. Where the Bot works: its default, the sandbox or the owner's
 * computer, with the sandbox's details to open when that is the default. Then the external environments it may
 * switch to; so far the owner's computer, for a Bot whose default is its sandbox. */
export function BotEnvironment({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const [busy, setBusy] = useState<"move" | "grant" | "start" | "stop" | "reset" | null>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const details = useId();
  const { computer, home, current, hostGranted, docker } = bot.environment;
  async function act(what: NonNullable<typeof busy>, work: () => Promise<Bot>, fallback: Parameters<typeof errorText>[1]) {
    setBusy(what); setError("");
    try { onSaved(await work()); }
    catch (reason) { setError(errorText(reason, fallback)); }
    finally { setBusy(null); }
  }
  const pick = (kind: EnvironmentKind) => { if (kind !== home && !busy) void act("move", () => api.setBotEnvironment(bot.id, kind), "environment.changeFailed"); };
  const run = (what: "start" | "stop" | "reset") => void act(what, () => api.computer(bot.id, what), "common.failed");
  const state = computer?.state;
  const [label, hint] = state ? STATE[state] : [null, null];
  const away = current !== home ? t(current === "host" ? "environment.awayHost" : "environment.awayComputer") : null;
  return <section className="jv-section" aria-label={t("environment.title")}><h3 className="jv-section-title">{t("environment.title")}</h3>
    <div className="jv-list">
      <div className="jv-list-row jv-static-row">
        <span className="jv-row-text"><strong>{t("environment.default")}</strong><span className={away ? "jv-env-away" : undefined}>{away ?? t("environment.defaultHint")}</span></span>
        <div className="jv-env-seg" role="radiogroup" aria-label={t("environment.default")}>
          {(["computer", "host"] as const).map(kind => <button key={kind} type="button" role="radio" aria-checked={home === kind} disabled={!!busy || (kind === "computer" && !docker)}
            title={kind === "computer" && !docker ? t("environment.noDocker") : undefined} onClick={() => pick(kind)}>{t(kind === "computer" ? "environment.computer" : "environment.host")}</button>)}
        </div>
      </div>
      {home === "computer" && state && label && hint && <>
        <button type="button" className="jv-list-row jv-choice-row jv-env-disclosure" aria-expanded={open} aria-controls={details} onClick={() => setOpen(!open)}>
          <span className="jv-row-text"><strong>{t("environment.details")}</strong></span>
          <span className="jv-status" data-ok={state === "running" || undefined} data-busy={state === "preparing" || undefined}>{t(label)}</span>
          <ChevronDownIcon aria-hidden="true"/>
        </button>
        {open && <div id={details} className="jv-list-row jv-static-row jv-env-details">
          <p>{t("environment.sandboxAbout")}{t(hint)}</p>
          {state !== "unavailable" && !confirming && <div className="jv-env-actions">
            <Button type="button" variant="outline" size="sm" disabled={!!busy || state === "preparing"} onClick={() => run(state === "running" ? "stop" : "start")}>
              {t(busy === "start" ? "environment.starting" : busy === "stop" ? "environment.stopping" : state === "running" ? "environment.stop" : "environment.start")}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={!!busy || state === "preparing"} onClick={() => setConfirming(true)}>{t("environment.reset")}</Button>
          </div>}
          {/* Asked in place: Bot info is itself a dialog. */}
          {confirming && <div className="jv-env-confirm" role="group" aria-label={t("environment.resetTitle", { name: bot.name })}>
            <strong>{t("environment.resetTitle", { name: bot.name })}</strong><p>{t("environment.resetBody")}</p>
            <div className="jv-env-confirm-actions"><Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
              <Button type="button" className="jv-primary" size="sm" onClick={() => { setConfirming(false); run("reset"); }}>{t("environment.resetConfirm")}</Button></div>
          </div>}
        </div>}
      </>}
    </div>
    {home === "computer" && <>
      <h4 className="jv-env-heading">{t("environment.external")}</h4>
      <div className="jv-list" role="group" aria-label={t("environment.external")}>
        <button type="button" role="switch" aria-checked={hostGranted} disabled={!!busy} className="jv-list-row jv-choice-row jv-env-access" onClick={() => void act("grant", () => api.grantHost(bot.id, !hostGranted), "environment.accessFailed")}>
          <span className="jv-row-text"><strong>{t("environment.host")}</strong><span>{t("environment.hostAbout")}</span></span>
          <span className="jv-env-switch" aria-hidden="true"/>
        </button>
      </div>
      <p className="jv-hint jv-env-note">{t("environment.externalHint")}</p>
    </>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
