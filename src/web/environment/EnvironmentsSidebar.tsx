import { ContainerIcon, LaptopIcon, MonitorIcon, PanelLeftCloseIcon, Search, ServerIcon, TerminalIcon } from "lucide-react";
import type { Bot, BotStatus } from "../../contract/bots";
import type { Device, SshMachine } from "../../contract/environment";
import type { TerminalSession, TerminalShell } from "../../contract/terminal";
import { BotAvatar } from "../avatar/BotAvatar";
import { ColumnHeader } from "../components/column-header";
import { ListRow } from "../components/list-row";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { t } from "../i18n";
import { IconButton } from "../ui";
import { STATE } from "./BotEnvironment";
import { deviceState, deviceSystem } from "./DeviceDetail";
import { machineAddress } from "./MachineDetail";

export type EnvCategory = "all" | "device" | "machine" | "sandbox";
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
  type: "container" | "vm" | "ssh" | "device";
  dotState?: "running" | "preparing" | "stopped" | "failed" | "unavailable";
  dotLabel?: string;
  compact?: boolean;
}) {
  const Icon = type === "device" ? LaptopIcon : type === "ssh" ? ServerIcon : type === "vm" ? MonitorIcon : ContainerIcon;
  return <span className="jv-env-tile-wrap">
    <span className="ui-tile" data-kind={type} data-compact={compact || undefined}><Icon aria-hidden="true"/></span>
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

/** Left environment navigation column with category quick filters, icon-corner status dots,
 * dimmed offline/stopped rows, collapsible toggle, and nested active terminal sub-items. */
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
  const totalCount = allDevices.length + allMachines.length + sandboxes.length;

  const shownDevices = (category === "all" || category === "device")
    ? allDevices.filter(item => matches(`${item.name} ${deviceSystem(item)}`)) : [];
  const shownMachines = (category === "all" || category === "machine")
    ? allMachines.filter(item => matches(`${item.name} ${machineAddress(item)}`)) : [];
  const shownSandboxes = (category === "all" || category === "sandbox")
    ? sandboxes.filter(item => matches(`${item.name} ${t("envs.sandboxOf", { name: item.name })}`)) : [];

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

  const categories: { id: EnvCategory; label: string; count: number }[] = [
    { id: "all", label: t("envs.catAll"), count: totalCount },
    { id: "device", label: t("envs.catDevices"), count: allDevices.length },
    { id: "machine", label: t("envs.catMachines"), count: allMachines.length },
    { id: "sandbox", label: t("envs.catSandboxes"), count: sandboxes.length },
  ];

  const hasVisible = shownDevices.length > 0 || shownMachines.length > 0 || shownSandboxes.length > 0;

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
        <em>{item.count}</em>
      </button>)}
    </div>

    <div className="jv-envs-scroll">
      {shownDevices.length > 0 && <>
        {category === "all" && <div className="jv-envs-group"><span>{t("envs.groupDevices")}</span><span>{shownDevices.length}</span></div>}
        {shownDevices.map(item => {
          const state = deviceState(item);
          const dotState = state === "online" ? "running" : state === "paused" ? "preparing" : "stopped";
          const picked: PickedEnv = { kind: "device", id: item.id };
          const sessions = terminalsByEnv.get(item.id) ?? [];
          const dimmed = state === "offline";
          return <div key={item.id} className="jv-env-entry" data-dimmed={dimmed || undefined}>
            <ListRow active={!adding && selectedKind === "device" && selectedId === item.id} onClick={() => onPick(picked)}
              leading={<EnvKindTile type="device" dotState={dotState} dotLabel={t(`devices.${state}`)}/>}
              title={item.name} sub={deviceSystem(item) || t("devices.kindDevice")}
              trailing={<><EnvFaces bots={botsOnDevice(item)} statuses={statuses}/>{!sessions.length && <TermBadge count={0}/>}</>}/>
            {renderSubTerms(picked, item.id, item.platform)}
          </div>;
        })}
      </>}

      {shownMachines.length > 0 && <>
        {category === "all" && <div className="jv-envs-group"><span>{t("envs.groupMachines")}</span><span>{shownMachines.length}</span></div>}
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

      {shownSandboxes.length > 0 && <>
        {category === "all" && <div className="jv-envs-group"><span>{t("envs.groupSandboxes")}</span><span>{shownSandboxes.length}</span></div>}
        {shownSandboxes.map(item => {
          const computer = item.environment.computer!;
          const picked: PickedEnv = { kind: "sandbox", id: item.id };
          const dimmed = computer.state === "stopped" || computer.state === "failed" || computer.state === "unavailable";
          return <div key={item.id} className="jv-env-entry" data-dimmed={dimmed || undefined}>
            <ListRow active={!adding && selectedKind === "sandbox" && selectedId === item.id} onClick={() => onPick(picked)}
              leading={<EnvKindTile type={computer.type} dotState={computer.state} dotLabel={t(STATE[computer.state])}/>}
              title={t("envs.sandboxOf", { name: item.name })}
              sub={`${t(computer.type === "vm" ? "environment.type.vm" : "environment.type.container")} · ${t(STATE[computer.state])}`}
              trailing={<EnvFaces bots={botsInSandbox(item)} statuses={statuses}/>}/>
            {renderSubTerms(picked, computer.id)}
          </div>;
        })}
      </>}

      {(query || category !== "all") && machines && !hasVisible && <p className="jv-envs-none">{t("envs.noMatch")}</p>}
      {error && <p className="jv-note-error" role="alert">{error}</p>}
    </div>
  </aside>;
}

function TermBadge({ count }: { count: number }) {
  if (!count) return null;
  const label = t("envs.terminalCount", { count });
  return <span className="jv-envs-term-badge" title={label} aria-label={label}><TerminalIcon aria-hidden="true"/>{count}</span>;
}
