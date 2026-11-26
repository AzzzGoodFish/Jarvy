import { FolderOpenIcon, TerminalIcon } from "lucide-react";
import type { Bot, BotStatus } from "../../contract/bots";
import type { Device, SshMachine } from "../../contract/environment";
import { Button } from "../components/ui/button";
import { t } from "../i18n";
import { GB, short } from "./amounts";
import { STATE } from "./BotEnvironment";
import { deviceState, deviceSystem } from "./DeviceDetail";
import { EnvFaces, shellShortLabel } from "./EnvironmentsSidebar";
import { machineAddress } from "./MachineDetail";

/** Status-and-actions summary card at the top of an environment's Overview tab:
 * Band 1 shows live status + active work + primary actions; Band 2 lays out read-only specs in a clean grid. */
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
  let disabledTerminal = false;
  let disabledFiles = false;
  const specs: { label: string; value: string; mono?: boolean }[] = [];

  if (device) {
    const state = deviceState(device);
    pillTone = state === "online" ? "ok" : state === "paused" ? "warn" : "muted";
    pillLabel = t(`devices.${state}`);
    summary = deviceSystem(device) || t("devices.kindDevice");
    disabledTerminal = state !== "online";
    disabledFiles = state !== "online";
    if (device.sandbox?.docker) {
      specs.push({ label: t("devices.poolSandboxes"), value: `${device.sandbox.activeContainers} / ${device.sandbox.maxContainers}`, mono: true });
      specs.push({ label: t("devices.poolCapacity"), value: t("environment.limits.machine", { cpus: device.sandbox.cpus, memory: short(device.sandbox.memory / GB, 1) }) });
      if (device.sandbox.image) specs.push({ label: t("environment.image"), value: device.sandbox.image, mono: true });
    }
    if (device.directory) specs.push({ label: t("machines.directory"), value: device.directory, mono: true });
    const availableShells = [
      device.shells.powershell ? t("devices.shellPowershell") : null,
      device.shells.bash ? shellShortLabel("bash", device.platform) : null,
    ].filter(Boolean).join(", ");
    if (availableShells) specs.push({ label: t("envs.availableShells"), value: availableShells, mono: true });
    else if (device.activeShell) specs.push({ label: t("devices.shell"), value: shellShortLabel(device.activeShell, device.platform), mono: true });
    if (device.client) specs.push({ label: t("devices.client"), value: device.client, mono: true });
    if (state === "offline" && device.seenAt) specs.push({ label: t("envs.lastOnline"), value: new Date(device.seenAt).toLocaleString() });
  } else if (machine) {
    pillTone = "ok";
    pillLabel = t("devices.kindMachine");
    summary = machineAddress(machine);
    specs.push({ label: t("machines.host"), value: machineAddress(machine), mono: true });
    if (machine.directory) specs.push({ label: t("machines.directory"), value: machine.directory, mono: true });
    specs.push({ label: t("machines.login"), value: t(machine.login === "password" ? "machines.loginPassword" : "machines.loginKey") });
  } else if (bot?.environment.computer) {
    const computer = bot.environment.computer;
    pillTone = computer.state === "running" ? "ok"
      : computer.state === "preparing" ? "warn"
      : computer.state === "failed" || computer.state === "unavailable" ? "danger"
      : "muted";
    pillLabel = t(STATE[computer.state]);
    summary = computer.computeNode
      ? `${t("environment.type.container")} · ${computer.computeNode.name}`
      : t(computer.type === "vm" ? "environment.type.vm" : "environment.type.container");
    disabledTerminal = computer.state === "unavailable";
    // Container sandboxes can always browse `/workspace` (local cache or last-synced S3 snapshot) even offline (A106, A109).
    disabledFiles = computer.type === "vm" && computer.state === "unavailable";
    if (computer.computeNode) specs.push({ label: t("environment.computeHost"), value: computer.computeNode.name });
    if (computer.container) specs.push({ label: t(computer.type === "vm" ? "environment.vm" : "environment.container"), value: computer.container, mono: true });
    if (computer.mount) specs.push({ label: t("environment.mount"), value: computer.mount, mono: true });
    if (computer.image) specs.push({ label: t("environment.image"), value: computer.image, mono: true });
  } else {
    return null;
  }

  return <section className="jv-ov-hero" aria-label={pillLabel}>
    <div className="jv-ov-hero-head">
      <div className="jv-ov-hero-status">
        <span className="jv-ov-pill" data-tone={pillTone}>
          <span className="jv-ov-pill-dot" aria-hidden="true"/>
          {pillLabel}
        </span>
        {device?.sandbox?.docker && <span className="jv-ov-pill">{t("devices.computeNodeBadge")}</span>}
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
      <div className="jv-ov-hero-actions">
        <Button type="button" className="jv-primary" size="sm" disabled={disabledTerminal} onClick={onOpenTerminal}>
          <TerminalIcon aria-hidden="true"/>{t("envs.openTerminal")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabledFiles} onClick={onBrowseFiles}>
          <FolderOpenIcon aria-hidden="true"/>{t("envs.browseFiles")}
        </Button>
      </div>
    </div>
    {specs.length > 0 && <dl className="jv-ov-specs">
      {specs.map(spec => <div key={spec.label} className="jv-ov-spec">
        <dt>{spec.label}</dt>
        <dd className={spec.mono ? "jv-mono" : undefined}>{spec.value}</dd>
      </div>)}
    </dl>}
  </section>;
}
