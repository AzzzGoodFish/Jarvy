import { useId, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type EnvironmentKind } from "../../contract/environment";
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

/** Where a Bot's file and command tools run (A50): its sandbox, or the owner's. A change applies from the Bot's
 * next command. Used in Bot info and in a new Bot's first setup. */
export function EnvironmentChoice({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const { busy, error, run } = useAction();
  const { home, docker } = bot.environment;
  async function pick(kind: EnvironmentKind) {
    if (kind === home || busy) return;
    await run("pick", async () => onSaved(await api.setBotEnvironment(bot.id, kind)), "environment.changeFailed");
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

/** Bot info's section (A50), in two parts. Where the Bot works: its default, the sandbox or the owner's
 * computer, with the sandbox's details to open when that is the default. Then the external environments it may
 * switch to: the owner's computer, for a Bot whose default is its sandbox, and each SSH machine (A57). */
export function BotEnvironment({ bot, onSaved }: { bot: Bot; onSaved: (bot: Bot) => void }) {
  const { doing: busy, error, run: perform } = useAction<"move" | "grant" | "start" | "stop" | "reset">();
  const [open, setOpen] = useState(false);
  /** Stopping and resetting are destructive: both ask in place first. */
  const [confirming, setConfirming] = useState<"stop" | "reset" | null>(null);
  const details = useId();
  const { computer, home, current, currentName, hostGranted, docker, machines = [] } = bot.environment;
  const act = (what: NonNullable<typeof busy>, work: () => Promise<Bot>, fallback: Key) => perform(what, async () => onSaved(await work()), fallback);
  const pick = (kind: EnvironmentKind) => { if (kind !== home && !busy) void act("move", () => api.setBotEnvironment(bot.id, kind), "environment.changeFailed"); };
  const run = (what: "start" | "stop" | "reset") => void act(what, () => api.computer(bot.id, what), "common.failed");
  const state = computer?.state;
  const [label, hint] = state ? STATE[state] : [null, null];
  const away = current === home ? null : current === "ssh" ? t("environment.awayMachine", { name: currentName ?? "" })
    : t(current === "host" ? "environment.awayHost" : "environment.awayComputer");
  return <section className="jv-section" aria-label={t("environment.title")}><h3 className="jv-section-title">{t("environment.title")}</h3>
    <div className="jv-list">
      <div className="jv-list-row jv-static-row">
        <span className="jv-row-text"><strong>{t("environment.default")}</strong>{away && <span className="jv-env-away">{away}</span>}</span>
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
        </div>}
      </>}
    </div>
    {(home === "computer" || machines.length > 0) && <>
      <h4 className="jv-env-heading">{t("environment.external")}</h4>
      <div className="jv-list" role="group" aria-label={t("environment.external")}>
        {home === "computer" && <button type="button" role="switch" aria-checked={hostGranted} disabled={!!busy} className="jv-list-row jv-choice-row jv-env-access" onClick={() => void act("grant", () => api.grantHost(bot.id, !hostGranted), "environment.accessFailed")}>
          <span className="jv-row-text"><strong>{t("environment.host")}</strong></span>
          <span className="jv-env-switch" aria-hidden="true"/>
        </button>}
        {machines.map(machine => <button key={machine.id} type="button" role="switch" aria-checked={machine.granted} disabled={!!busy} className="jv-list-row jv-choice-row jv-env-access"
          onClick={() => void act("grant", () => api.grantBotMachine(bot.id, machine.id, !machine.granted), "environment.accessFailed")}>
          <span className="jv-row-text"><strong>{machine.name}</strong></span>
          <span className="jv-env-switch" aria-hidden="true"/>
        </button>)}
      </div>
    </>}
    {error && <p className="jv-note-error" role="alert">{error}</p>}
  </section>;
}
