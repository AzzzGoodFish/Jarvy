import { FolderOpenIcon, TerminalIcon } from "lucide-react";
import type { Bot, BotStatus } from "../../contract/bots";
import type { Device, SshMachine } from "../../contract/environment";
import { Button } from "../components/ui/button";
import { t } from "../i18n";
import { STATE } from "./BotEnvironment";
import { deviceState, deviceSystem } from "./DeviceDetail";
import { EnvFaces, shellShortLabel } from "./EnvironmentsSidebar";
import { machineAddress } from "./MachineDetail";

/** Status-and-actions summary card at the top of an environment's Overview tab. */
export function EnvironmentHero({
  device, machine, bot, here, statuses, runningTerminals, onOpenTerminal, onBrowseFiles,
}: {
  device?: Device;
  machine?: SshMachine;
  bot?: Bot;
  here: Bot[];
  statuses: Record<string, BotStatus>;
  runningTerminals: number;
  onOpenTerminal: () => void;
  onBrowseFiles: () => void;
}) {
  let pillTone: "ok" | "warn" | "danger" | "muted" = "ok";
  let pillLabel = "";
  let summary = "";
  let disabledActions = false;
  const facts: { label: string; value: string }[] = [];

  if (device) {
    const state = deviceState(device);
    pillTone = state === "online" ? "ok" : state === "paused" ? "warn" : "muted";
    pillLabel = t(`devices.${state}`);
    summary = deviceSystem(device) || t("devices.kindDevice");
    disabledActions = state !== "online";
    if (device.directory) facts.push({ label: t("machines.directory"), value: device.directory });
    if (device.activeShell) facts.push({ label: t("devices.shell"), value: shellShortLabel(device.activeShell, device.platform) });
    if (device.client) facts.push({ label: t("devices.client"), value: device.client });
  } else if (machine) {
    pillTone = "ok";
    pillLabel = t("devices.kindMachine");
    summary = machineAddress(machine);
    if (machine.directory) facts.push({ label: t("machines.directory"), value: machine.directory });
    facts.push({ label: t("machines.login"), value: t(machine.login === "password" ? "machines.loginPassword" : "machines.loginKey") });
  } else if (bot?.environment.computer) {
    const computer = bot.environment.computer;
    pillTone = computer.state === "running" ? "ok"
      : computer.state === "preparing" ? "warn"
      : computer.state === "failed" || computer.state === "unavailable" ? "danger"
      : "muted";
    pillLabel = t(STATE[computer.state]);
    summary = t(computer.type === "vm" ? "environment.type.vm" : "environment.type.container");
    disabledActions = computer.state === "unavailable";
    if (computer.mount) facts.push({ label: t("environment.mount"), value: computer.mount });
    if (computer.container) facts.push({ label: t(computer.type === "vm" ? "environment.vm" : "environment.container"), value: computer.container });
  } else {
    return null;
  }

  return <div className="jv-ov-hero">
    <div className="jv-ov-hero-info">
      <div className="jv-ov-hero-top">
        <span className="jv-ov-pill" data-tone={pillTone}>
          <span className="jv-ov-pill-dot" aria-hidden="true"/>
          {pillLabel}
        </span>
        {summary && <span className="jv-ov-hero-sub">{summary}</span>}
        {runningTerminals > 0 && <>
          <span className="jv-ov-sep" aria-hidden="true">·</span>
          <span className="jv-ov-hero-sub">{t("envs.terminalCount", { count: runningTerminals })}</span>
        </>}
        {here.length > 0 && <>
          <span className="jv-ov-sep" aria-hidden="true">·</span>
          <span className="jv-ov-hero-bots">
            <EnvFaces bots={here} statuses={statuses}/>
            <span>{t("envs.workingHere", { names: here.map(item => item.name).join(t("common.listSeparator")), count: here.length })}</span>
          </span>
        </>}
      </div>
      {facts.length > 0 && <div className="jv-ov-hero-facts">
        {facts.map(fact => <span key={fact.label} className="jv-ov-fact-chip">
          <span>{fact.label}</span>
          <code>{fact.value}</code>
        </span>)}
      </div>}
    </div>
    <div className="jv-ov-hero-actions">
      <Button type="button" className="jv-primary" size="sm" disabled={disabledActions} onClick={onOpenTerminal}>
        <TerminalIcon aria-hidden="true"/>{t("envs.openTerminal")}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={disabledActions} onClick={onBrowseFiles}>
        <FolderOpenIcon aria-hidden="true"/>{t("envs.browseFiles")}
      </Button>
    </div>
  </div>;
}
