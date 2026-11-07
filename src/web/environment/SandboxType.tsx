import { useEffect, useState } from "react";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import type { ComputerType, VmSupport } from "../../contract/environment";
import { t } from "../i18n";
import { Button } from "../components/ui/button";
import { useAction } from "../action";

const TYPES: readonly ComputerType[] = ["container", "vm"];

/** Bot info's choice of what the sandbox is (A85): a container, or a VM with Docker inside when this machine can run
 * one. Whether it can is checked when the section first opens (a trial VM, a few seconds) and said when it can't, with
 * the reason; how to fix that is the agent Bot's to explain (its setup skill). Switching makes a fresh sandbox, so it
 * asks in place first, as a reset does. */
export function SandboxType({ bot, disabled, onSaved }: { bot: Bot; disabled: boolean; onSaved: (bot: Bot) => void }) {
  const computer = bot.environment.computer!;
  const [support, setSupport] = useState<VmSupport | null>(null);
  const [asking, setAsking] = useState<ComputerType | null>(null);
  const { doing, error, run } = useAction<"switch" | "check">();
  useEffect(() => {
    let alive = true;
    const load = (ask: () => Promise<VmSupport>) => void ask().then(next => { if (alive) setSupport(next); }).catch(() => {});
    if (!support) load(api.vmSupport);
    // A check takes a few seconds, or minutes when the sandbox image is built first: asked again until it is done.
    const timer = support?.state === "checking" || support?.state === "unknown" ? setTimeout(() => load(api.vmSupport), 2000) : undefined;
    return () => { alive = false; clearTimeout(timer); };
  }, [support]);
  const canVm = computer.type === "vm" || support?.state === "available";
  const note = support?.state === "checking" || support?.state === "unknown" ? t("environment.type.checking")
    : support?.state === "unavailable" && computer.type !== "vm" ? t("environment.type.unavailable", { why: t(`environment.type.why.${support.reason ?? "failed"}`) }) : null;
  const choose = (type: ComputerType) => void run("switch", async () => { onSaved(await api.setComputerType(bot.id, type)); setAsking(null); }, "common.failed");
  return <>
    <div className="jv-list-row jv-static-row jv-env-fact jv-env-type"><span>{t("environment.type")}</span>
      <div className="jv-seg" role="radiogroup" aria-label={t("environment.type")}>
        {TYPES.map(type => <button key={type} type="button" role="radio" aria-checked={computer.type === type}
          disabled={disabled || !!doing || (type === "vm" && !canVm)} onClick={() => { if (type !== computer.type) setAsking(type); }}>{t(`environment.type.${type}`)}</button>)}
      </div>
    </div>
    {(note || asking || error) && <div className="jv-list-row jv-static-row jv-env-details">
      {note && !asking && <p className="jv-env-type-note">{note}
        {support?.state === "unavailable" && <Button type="button" variant="link" size="sm" disabled={!!doing}
          onClick={() => void run("check", async () => setSupport(await api.checkVmSupport()))}>{t("environment.type.recheck")}</Button>}</p>}
      {asking && <div className="jv-env-confirm" role="group" aria-label={t(`environment.type.${asking}Title`, { name: bot.name })}>
        <strong>{t(`environment.type.${asking}Title`, { name: bot.name })}</strong><p>{t(`environment.type.${asking}Body`)}</p>
        <div className="jv-env-confirm-actions"><Button type="button" variant="ghost" size="sm" onClick={() => setAsking(null)}>{t("common.cancel")}</Button>
          <Button type="button" className="jv-primary" size="sm" disabled={!!doing} onClick={() => choose(asking)}>
            {t(doing === "switch" ? "environment.type.switching" : "environment.type.confirm")}</Button></div>
      </div>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>}
  </>;
}
