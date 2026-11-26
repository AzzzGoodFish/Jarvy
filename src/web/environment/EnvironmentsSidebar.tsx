import { ContainerIcon, CpuIcon, LaptopIcon, MonitorIcon, PanelLeftCloseIcon, Search, ServerIcon } from "lucide-react";
import type { Bot, BotStatus } from "../../contract/bots";
import type { Device, SshMachine } from "../../contract/environment";
import type { TerminalSession, TerminalShell } from "../../contract/terminal";
import { BotAvatar } from "../avatar/BotAvatar";
import { ColumnHeader } from "../components/column-header";
import { ListRow } from "../components/list-row";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { t } from "../i18n";
import { IconButton } from "../ui";
import { GB, short } from "./amounts";
import { STATE } from "./BotEnvironment";
import { allowsHostAccess, isComputeNode, isDualRole } from "./device-roles";
import { deviceState, deviceSystem } from "./DeviceDetail";
import { machineAddress } from "./MachineDetail";

/** Distributed-native categories: Bot sandboxes, Compute pool nodes (--sandbox), and Remote hosts (desktop/host + SSH). */
export type EnvCategory = "all" | "sandbox" | "compute" | "host";
export type PickedEnv = { kind: "sandbox" | "machine" | "device"; id: string };

const FACES = 3;

export function shellShortLabel(shell: TerminalShell | undefined, platform?: string): string {
  if (!shell) return "";
  if (shell === "powershell") return t("devices.shellPowershell");
  if (shell === "cmd") return "cmd";
  return platform === "win32" ? t("devices.shellBash") : t("devices.shellBashOther");
}

/** Icon tile for an environment kind, optionally carrying a bottom-right status corner dot. */
export function EnvKindTile({ type, dotState, dotLabel, compact }: {
  type: "container" | "vm" | "ssh" | "device" | "compute";
  dotState?: "running" | "preparing" | "stopped" | "failed" | "unavailable";
  dotLabel?: string;
  compact?: boolean;
}) {
  const Icon = type === "compute" ? CpuIcon : type === "device" ? LaptopIcon : type === "ssh" ? ServerIcon : type === "vm" ? MonitorIcon : ContainerIcon;
  return <span className="jv-env-tile-wrap">
    <span className="ui-tile" data-kind={type === "compute" ? "device" : type} data-compact={compact || undefined}><Icon aria-hidden="true"/></span>
    {dotState && <span className="jv-env-corner-dot" data-state={dotState} role="img" aria-label={dotLabel} title={dotLabel}/>}
  </span>;
}

/** The Bots working in a place now, overlapping, a stopped one asleep (A88); past three, how many more. */
export function EnvFaces({ bots, statuses }: { bots: Bot[]; statuses: Record<string, BotStatus> }) {
  if (!bots.length) return null;
  return <span className="jv-envs-faces" title={bots.map(bot => bot.name).join(t("common.listSeparator")) || undefined}>
    {bots.slice(0, FACES).map(bot => <BotAvatar key={bot.id} color={bot.color} mood={bot.mood} size={20} crown={bot.agent} asleep={statuses[bot.id]?.status === "stop"}/>)}
    {bots.length > FACES && <span className="jv-envs-more">+{bots.length - FACES}</span>}
  </span>;
}

/** Left environment navigation column separating Bot Sandboxes, Compute Pool Nodes, and Remote Hosts (A109). */
export function EnvironmentsSidebar({
  devices, machines, sandboxes, statuses, filter, category, adding,
  selectedKind, selectedId, activeTerminalId, inTerminalTab,
  terminalsByEnv, botsOnMachine, botsOnDevice, botsInSandbox, error,
  onFilterChange, onCategoryChange, onPick, onPickTerminal, onAdd, onCollapse,
}: {
  devices: Device[] | null;
  machines: SshMachine[] | null;
  sandboxes: Bot[];
  statuses: Record<string, BotStatus>;
  filter: string;
  category: EnvCategory;
  adding: boolean;
  selectedKind: "device" | "machine" | "sandbox" | null;
  selectedId: string | null;
  activeTerminalId: string | null;
  inTerminalTab: boolean;
  terminalsByEnv: Map<string, TerminalSession[]>;
  botsOnMachine: (machine: SshMachine) => Bot[];
  botsOnDevice: (device: Device) => Bot[];
  botsInSandbox: (bot: Bot) => Bot[];
  error: string | null;
  onFilterChange: (next: string) => void;
  onCategoryChange: (next: EnvCategory) => void;
  onPick: (next: PickedEnv) => void;
  onPickTerminal: (env: PickedEnv, sessionId: string) => void;
  onAdd: () => void;
  onCollapse: () => void;
}) {
  const query = filter.trim().toLocaleLowerCase();
  const matches = (text: string) => !query || text.toLocaleLowerCase().includes(query);

  const allDevices = devices ?? [];
  const allMachines = machines ?? [];

  const shownSandboxes = (category === "all" || category === "sandbox")
    ? sandboxes.filter(item => matches(`${item.name} ${t("envs.sandboxOf", { name: item.name })} ${item.environment.computer?.computeNode?.name ?? ""}`)) : [];
  const shownCompute = (category === "all" || category === "compute")
    ? allDevices.filter(item => isComputeNode(item) && matches(`${item.name} ${deviceSystem(item)}`)) : [];
  // In "all", show pure host devices under Remote Hosts (dual-role nodes appear under Compute Nodes with a dual-role sub).
  // In "host", show every host-capable device (including dual-role) + SSH machines.
  const shownHostDevices = category === "host"
    ? allDevices.filter(item => allowsHostAccess(item) && matches(`${item.name} ${deviceSystem(item)}`))
    : category === "all"
      ? allDevices.filter(item => allowsHostAccess(item) && !isComputeNode(item) && matches(`${item.name} ${deviceSystem(item)}`))
      : [];
  const shownMachines = (category === "all" || category === "host")
    ? allMachines.filter(item => matches(`${item.name} ${machineAddress(item)}`)) : [];

  const renderSubTerms = (env: PickedEnv, envId: string, platform?: string) => {
    const sessions = terminalsByEnv.get(envId) ?? [];
    if (!sessions.length) return null;
    const envActive = selectedKind === env.kind && selectedId === env.id;
    return <div className="jv-env-subterms" role="group">
      {sessions.map(session => {
        const isCurrent = envActive && inTerminalTab && activeTerminalId === session.id;
        const meta = session.foreground || shellShortLabel(session.shell, platform);
        return <button key={session.id} type="button" className="jv-env-subterm" data-active={isCurrent || undefined}
          onClick={() => onPickTerminal(env, session.id)}>
          <span className="jv-term-dot" data-state={session.state} aria-hidden="true"/>
          <span className="jv-env-subterm-name">{session.name}</span>
          {meta && <span className="jv-env-subterm-meta">{meta}</span>}
        </button>;
      })}
    </div>;
  };

  const categories: { id: EnvCategory; label: string }[] = [
    { id: "all", label: t("envs.catAll") },
    { id: "sandbox", label: t("envs.catSandboxes") },
    { id: "compute", label: t("envs.catCompute") },
    { id: "host", label: t("envs.catHosts") },
  ];

  const hostCount = shownHostDevices.length + shownMachines.length;
  const hasVisible = shownSandboxes.length > 0 || shownCompute.length > 0 || hostCount > 0;

  return <aside className="jv-envs-list">
    <ColumnHeader place="sidebar" title={t("rail.environments")}
      actions={<>
        <button type="button" className="ui-iconbtn jv-envs-collapse-btn" aria-label={t("envs.collapseSidebar")} title={t("envs.collapseSidebar")} onClick={onCollapse}>
          <PanelLeftCloseIcon className="ui-icon" aria-hidden="true"/>
        </button>
        <IconButton icon="add" label={t("machines.add")} aria-pressed={adding} onClick={onAdd}/>
      </>}/>
    <div className="mx-3 mt-1 mb-2 shrink-0" role="search">
      <InputGroup className="h-9 bg-background">
        <InputGroupInput type="search" value={filter} onChange={event => onFilterChange(event.target.value)} placeholder={t("envs.search")} aria-label={t("envs.search")}
          onKeyDown={event => { if (event.key === "Escape" && filter) { event.preventDefault(); onFilterChange(""); } }} className="text-sm"/>
        <InputGroupAddon align="inline-start"><Search aria-hidden="true"/></InputGroupAddon>
      </InputGroup>
    </div>

    <div className="jv-envs-cats" role="tablist" aria-label={t("rail.environments")}>
      {categories.map(item => <button key={item.id} type="button" role="tab" className="jv-envs-cat"
        aria-selected={category === item.id} data-active={category === item.id || undefined}
        onClick={() => onCategoryChange(item.id)}>
        <span>{item.label}</span>
      </button>)}
    </div>

    <div className="jv-envs-scroll">
      {shownSandboxes.length > 0 && <>
        {category === "all" && <div className="jv-envs-group"><span>{t("envs.groupSandboxes")}</span><span>{shownSandboxes.length}</span></div>}
        {shownSandboxes.map(item => {
          const computer = item.environment.computer!;
          const picked: PickedEnv = { kind: "sandbox", id: item.id };
          const dimmed = computer.state === "stopped" || computer.state === "failed" || computer.state === "unavailable";
          const sandboxSub = [
            t(STATE[computer.state]),
            computer.computeNode?.name ?? (computer.localDocker === false && computer.state !== "running" ? t("environment.workspaceReadyShort") : undefined),
          ].filter(Boolean).join(" · ");
          return <div key={item.id} className="jv-env-entry" data-dimmed={dimmed || undefined}>
            <ListRow active={!adding && selectedKind === "sandbox" && selectedId === item.id} onClick={() => onPick(picked)}
              leading={<EnvKindTile type={computer.type} dotState={computer.state} dotLabel={t(STATE[computer.state])}/>}
              title={t("envs.sandboxOf", { name: item.name })}
              sub={sandboxSub}
              trailing={<EnvFaces bots={botsInSandbox(item)} statuses={statuses}/>}/>
            {renderSubTerms(picked, computer.id)}
          </div>;
        })}
      </>}

      {shownCompute.length > 0 && <>
        {category === "all" && <div className="jv-envs-group"><span>{t("envs.groupCompute")}</span><span>{shownCompute.length}</span></div>}
        {shownCompute.map(item => {
          const state = deviceState(item);
          const dotState = state === "online" ? "running" : state === "paused" ? "preparing" : "stopped";
          const picked: PickedEnv = { kind: "device", id: item.id };
          const dimmed = state === "offline";
          const roleNote = isDualRole(item) ? t("devices.roleDualShort") : item.sandbox?.vm ? "Docker · KVM" : undefined;
          const activeTotal = (item.sandbox?.activeContainers ?? 0) + (item.sandbox?.activeVms ?? 0);
          const cap = state === "online" && item.sandbox && (item.sandbox.docker || item.sandbox.vm)
            ? `${activeTotal}/${item.sandbox.maxContainers} · ${item.sandbox.cpus}C/${short(item.sandbox.memory / GB, 0)}G`
            : t(`devices.${state}`);
          const sub = [cap, roleNote].filter(Boolean).join(" · ");
          return <div key={item.id} className="jv-env-entry" data-dimmed={dimmed || undefined}>
            <ListRow active={!adding && selectedKind === "device" && selectedId === item.id} onClick={() => onPick(picked)}
              leading={<EnvKindTile type="compute" dotState={dotState} dotLabel={t(`devices.${state}`)}/>}
              title={item.name} sub={sub}
              trailing={<EnvFaces bots={botsOnDevice(item)} statuses={statuses}/>}/>
            {renderSubTerms(picked, item.id, item.platform)}
          </div>;
        })}
      </>}

      {hostCount > 0 && <>
        {category === "all" && <div className="jv-envs-group"><span>{t("envs.groupHosts")}</span><span>{hostCount}</span></div>}
        {shownHostDevices.map(item => {
          const state = deviceState(item);
          const dotState = state === "online" ? "running" : state === "paused" ? "preparing" : "stopped";
          const picked: PickedEnv = { kind: "device", id: item.id };
          const dimmed = state === "offline";
          return <div key={item.id} className="jv-env-entry" data-dimmed={dimmed || undefined}>
            <ListRow active={!adding && selectedKind === "device" && selectedId === item.id} onClick={() => onPick(picked)}
              leading={<EnvKindTile type="device" dotState={dotState} dotLabel={t(`devices.${state}`)}/>}
              title={item.name} sub={deviceSystem(item) || t("devices.roleHost")}
              trailing={<EnvFaces bots={botsOnDevice(item)} statuses={statuses}/>}/>
            {renderSubTerms(picked, item.id, item.platform)}
          </div>;
        })}
        {shownMachines.map(item => {
          const picked: PickedEnv = { kind: "machine", id: item.id };
          return <div key={item.id} className="jv-env-entry">
            <ListRow active={!adding && selectedKind === "machine" && selectedId === item.id} onClick={() => onPick(picked)}
              leading={<EnvKindTile type="ssh" dotState="running" dotLabel={t("devices.kindMachine")}/>}
              title={item.name} sub={<span className="jv-mono">{machineAddress(item)}</span>}
              trailing={<EnvFaces bots={botsOnMachine(item)} statuses={statuses}/>}/>
            {renderSubTerms(picked, item.id)}
          </div>;
        })}
      </>}

      {(query || category !== "all") && machines && !hasVisible && <p className="jv-envs-none">{t("envs.noMatch")}</p>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>
  </aside>;
}
