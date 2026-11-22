import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, PanelLeftOpenIcon } from "lucide-react";
import { api } from "../api";
import type { Bot, BotStatus } from "../../contract/bots";
import type { Device, SshMachine } from "../../contract/environment";
import type { TerminalSession } from "../../contract/terminal";
import { errorText } from "../errors";
import { BotPorts } from "../ports/BotPorts";
import { ColumnHeader } from "../components/column-header";
import { t } from "../i18n";
import { BotEnvironment, STATE } from "./BotEnvironment";
import { DeviceConnect, DeviceDetail, deviceState, deviceSystem } from "./DeviceDetail";
import { EnvironmentFiles } from "./EnvironmentFiles";
import { EnvironmentHero } from "./EnvironmentHero";
import {
  EnvironmentsSidebar, EnvKindTile, type EnvCategory, type PickedEnv,
} from "./EnvironmentsSidebar";
import {
  EnvironmentTerminals, type OpenTerminalRequest, type ShellOption, type TerminalAvailability,
} from "./EnvironmentTerminals";
import { MachineDetail, machineAddress } from "./MachineDetail";
import { MachineForm } from "./MachineForm";
import "../styles/model-workbench.css";
import "../styles/secrets.css";
import "../styles/machines.css";
import "../styles/environments.css";
import "../styles/terminals.css";
import "../styles/env-files.css";

type DetailTab = "overview" | "terminal" | "files";
const COLLAPSED_KEY = "jarvy-envs-sidebar-collapsed";
/** The pick and tab, kept while the page is away (the chats, the agent Bot's page) and lost on a reload. */
let kept: PickedEnv | null = null;
let keptTab: DetailTab = "overview";

function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}

/** The Environments page (A89, A103, A104): categorized, collapsible environment list with nested active
 * terminals on the left; status-first Overview, unified multi-shell Terminal, and Files on the right. */
export function Environments({ active, bots, statuses, adding, terminalVersion = 0, onAdding, onSaved }: {
  active: boolean; bots: Bot[]; statuses: Record<string, BotStatus>; adding: boolean; terminalVersion?: number; onAdding: (adding: boolean) => void; onSaved: (bot: Bot) => void;
}) {
  const [machines, setMachines] = useState<SshMachine[] | null>(null), [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null), [connecting, setConnecting] = useState(false);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [picked, setPicked] = useState<PickedEnv | null>(kept), [open, setOpen] = useState(adding), [filter, setFilter] = useState("");
  const [category, setCategory] = useState<EnvCategory>("all");
  const [tab, setTab] = useState<DetailTab>(keptTab), [maximized, setMaximized] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const [quickPickerOpen, setQuickPickerOpen] = useState(false);
  const [selectedTermByEnv, setSelectedTermByEnv] = useState<Record<string, string>>({});
  const [openTermReq, setOpenTermReq] = useState<OpenTerminalRequest | null>(null);
  const reqSeq = useRef(0);

  const loadTerminals = useCallback(async () => {
    try { const view = await api.terminals(); setTerminals(view.terminals); } catch { /* ignore transient poll errors */ }
  }, []);
  useEffect(() => { void api.machines().then(view => setMachines(view.machines)).catch(reason => setError(errorText(reason))); }, []);
  useEffect(() => { void loadTerminals(); }, [loadTerminals, terminalVersion]);
  // A computer comes online, goes away or is added from its own side, so the list is asked again now and then while visible.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => void api.devices().then(view => { if (alive) setDevices(view.devices); }).catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [active]);
  useEffect(() => { if (adding) { setOpen(true); setMaximized(false); setQuickPickerOpen(false); } }, [adding]);
  useEffect(() => {
    if (!quickPickerOpen) return;
    const close = () => setQuickPickerOpen(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setQuickPickerOpen(false); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [quickPickerOpen]);

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
    setQuickPickerOpen(false);
  };

  const sandboxes = bots.filter(bot => bot.environment.computer);
  const botsOnMachine = (item: SshMachine) => bots.filter(b => b.environment.current === "ssh" && b.environment.currentName === item.name);
  const botsOnDevice = (item: Device) => bots.filter(b => b.environment.current === "device" && b.environment.currentName === item.name);
  const botsInSandbox = (item: Bot) => item.environment.current === "computer" ? [item] : [];

  const chosenMachine = picked?.kind === "machine" ? machines?.find(item => item.id === picked.id) : undefined;
  const chosenSandbox = picked?.kind === "sandbox" ? sandboxes.find(b => b.id === picked.id) : undefined;
  const chosenDevice = picked?.kind === "device" ? devices?.find(item => item.id === picked.id) : undefined;
  const none = !chosenMachine && !chosenSandbox && !chosenDevice;
  const device = adding ? undefined : chosenDevice ?? (none ? devices?.[0] : undefined);
  const machine = adding || device ? undefined : chosenMachine ?? (none ? machines?.[0] : undefined);
  const bot = adding || machine || device ? undefined : chosenSandbox ?? (none && (machines || error) ? sandboxes[0] : undefined);

  const selectedKind = device ? "device" : machine ? "machine" : bot ? "sandbox" : null;
  const selectedItemId = device ? device.id : machine ? machine.id : bot ? bot.id : null;

  const pick = (next: PickedEnv) => { kept = next; setPicked(next); onAdding(false); setOpen(true); setQuickPickerOpen(false); };
  const switchTab = (next: DetailTab) => { keptTab = next; setTab(next); if (next === "overview") setMaximized(false); };
  const selectTermSession = useCallback((envId: string, sessionId: string) => {
    setSelectedTermByEnv(prev => prev[envId] === sessionId ? prev : { ...prev, [envId]: sessionId });
  }, []);

  const pickTerminalFromSidebar = (env: PickedEnv, sessionId: string) => {
    const envId = env.kind === "sandbox" ? bots.find(b => b.id === env.id)?.environment.computer?.id ?? env.id : env.id;
    selectTermSession(envId, sessionId);
    pick(env);
    switchTab("terminal");
  };

  const here = device ? botsOnDevice(device) : machine ? botsOnMachine(machine) : bot ? botsInSandbox(bot) : [];
  const status = bot && statuses[bot.id];
  const terminalsByEnv = useMemo(() => {
    const grouped = new Map<string, TerminalSession[]>();
    for (const item of terminals) {
      const list = grouped.get(item.environmentId);
      if (list) list.push(item); else grouped.set(item.environmentId, [item]);
    }
    return grouped;
  }, [terminals]);
  const runningCount = (envId: string) => (terminalsByEnv.get(envId) ?? []).filter(item => item.state === "running").length;
  const selectedEnvId = device ? device.id : machine ? machine.id : bot?.environment.computer?.id ?? null;
  const selectedSessions = selectedEnvId ? terminalsByEnv.get(selectedEnvId) ?? [] : [];
  const selectedRunning = selectedEnvId ? runningCount(selectedEnvId) : 0;
  const activeTerminalId = selectedEnvId
    ? selectedSessions.find(item => item.id === selectedTermByEnv[selectedEnvId])?.id ?? selectedSessions[selectedSessions.length - 1]?.id ?? null
    : null;

  const availability: TerminalAvailability = device
    ? !device.online ? { kind: "device_offline" } : device.paused ? { kind: "device_paused" } : { kind: "ready" }
    : bot?.environment.computer
      ? bot.environment.computer.state === "unavailable" ? { kind: "sandbox_unavailable" }
      : bot.environment.computer.state === "stopped" || bot.environment.computer.state === "failed" ? { kind: "sandbox_stopped" }
      : bot.environment.computer.state === "preparing" ? { kind: "sandbox_stopped", starting: true }
      : { kind: "ready" }
    : { kind: "ready" };

  const availableShells = useMemo<ShellOption[]>(() => {
    if (!device) return [];
    const list: ShellOption[] = [];
    if (device.platform === "win32") {
      list.push({ id: "powershell", label: t("devices.shellPowershell"), isDefault: device.activeShell === "powershell" });
      if (device.shells.bash) list.push({ id: "bash", label: t("devices.shellBash"), isDefault: device.activeShell === "bash" });
      list.push({ id: "cmd", label: t("terminal.shellCmd"), isDefault: !device.activeShell });
    } else {
      if (device.shells.bash) list.push({ id: "bash", label: t("devices.shellBashOther"), isDefault: device.activeShell !== "powershell" });
      if (device.shells.powershell) list.push({ id: "powershell", label: t("devices.shellPowershell"), isDefault: device.activeShell === "powershell" });
    }
    return list;
  }, [device]);

  const showTerminal = !adding && !!selectedEnvId && tab === "terminal";
  const showFiles = !adding && !!selectedEnvId && tab === "files";

  const refreshBot = () => {
    if (!bot) return;
    void api.bots().then(view => {
      const updated = view.bots.find(item => item.id === bot.id);
      if (updated) onSaved(updated);
    }).catch(() => {});
  };

  const openTerminalInDir = (cwd: string) => {
    if (!selectedEnvId) return;
    switchTab("terminal");
    setOpenTermReq({ seq: ++reqSeq.current, environmentId: selectedEnvId, cwd });
  };

  const quickEntries = useMemo(() => {
    const out: { key: string; env: PickedEnv; envId: string; name: string; sub: string; dot: "running" | "preparing" | "stopped" | "failed" | "unavailable" }[] = [];
    for (const d of devices ?? []) {
      const st = deviceState(d);
      out.push({ key: `d:${d.id}`, env: { kind: "device", id: d.id }, envId: d.id, name: d.name, sub: deviceSystem(d) || t("devices.kindDevice"), dot: st === "online" ? "running" : st === "paused" ? "preparing" : "stopped" });
    }
    for (const m of machines ?? []) {
      out.push({ key: `m:${m.id}`, env: { kind: "machine", id: m.id }, envId: m.id, name: m.name, sub: machineAddress(m), dot: "running" });
    }
    for (const b of sandboxes) {
      const c = b.environment.computer!;
      out.push({ key: `s:${b.id}`, env: { kind: "sandbox", id: b.id }, envId: c.id, name: t("envs.sandboxOf", { name: b.name }), sub: t(STATE[c.state]), dot: c.state });
    }
    return out;
  }, [devices, machines, sandboxes]);

  const headerKind = device ? "device" : machine ? "ssh" : bot ? bot.environment.computer!.type : null;
  const headerTitle = adding ? t(connecting ? "devices.connect" : "machines.add") : device ? device.name : machine ? machine.name : bot ? t("envs.sandboxOf", { name: bot.name }) : "";
  const headerSub = device ? deviceSystem(device) : machine ? <span className="jv-mono">{machineAddress(machine)}</span> : undefined;

  return <section className="jv-envs" data-inactive={!active || undefined} data-open={open || undefined}
    data-collapsed={collapsed && !adding ? "" : undefined}
    data-maximized={active && (showTerminal || showFiles) && maximized ? "" : undefined}
    aria-hidden={!active || undefined} inert={!active || undefined} aria-label={t("rail.environments")}>
    <EnvironmentsSidebar
      devices={devices} machines={machines} sandboxes={sandboxes} statuses={statuses}
      filter={filter} category={category} adding={adding}
      selectedKind={selectedKind} selectedId={selectedItemId}
      activeTerminalId={activeTerminalId} inTerminalTab={showTerminal}
      terminalsByEnv={terminalsByEnv} botsOnMachine={botsOnMachine} botsOnDevice={botsOnDevice} botsInSandbox={botsInSandbox}
      error={error} onFilterChange={setFilter} onCategoryChange={setCategory}
      onPick={pick} onPickTerminal={pickTerminalFromSidebar}
      onAdd={() => { onAdding(true); setOpen(true); setCollapsed(false); }}
      onCollapse={toggleCollapsed}/>

    <main className="jv-envs-detail jv-ui" data-mode={showTerminal ? "terminal" : showFiles ? "files" : "overview"}>
      <ColumnHeader place="content" as="h2"
        leading={<>
          <button type="button" className="jv-envs-back" aria-label={t("envs.back")} onClick={() => { setOpen(false); setMaximized(false); onAdding(false); }}>
            <ChevronLeftIcon aria-hidden="true"/>
          </button>
          {collapsed && !adding && <button type="button" className="ui-iconbtn jv-envs-expand-btn" aria-label={t("envs.expandSidebar")} title={t("envs.expandSidebar")} onClick={toggleCollapsed}>
            <PanelLeftOpenIcon className="ui-icon" aria-hidden="true"/>
          </button>}
          {collapsed && !adding && headerKind ? <div className="jv-envs-quick-wrap">
            <button type="button" className="jv-envs-quick-btn" aria-label={t("envs.switchEnvironment")} aria-expanded={quickPickerOpen}
              onClick={event => { event.stopPropagation(); setQuickPickerOpen(v => !v); }}>
              <EnvKindTile type={headerKind} compact/>
              <span className="jv-envs-quick-title">{headerTitle}</span>
              <ChevronDownIcon className="jv-envs-quick-chevron" aria-hidden="true"/>
            </button>
            {quickPickerOpen && <div className="jv-envs-quick-menu" role="menu" onClick={event => event.stopPropagation()}>
              {quickEntries.map(entry => {
                const count = runningCount(entry.envId);
                const isCurrent = selectedKind === entry.env.kind && selectedItemId === entry.env.id;
                return <button key={entry.key} type="button" role="menuitem" className="jv-envs-quick-item" data-active={isCurrent || undefined}
                  onClick={() => pick(entry.env)}>
                  <span className="jv-envs-state" data-state={entry.dot} aria-hidden="true"/>
                  <span className="jv-envs-quick-name">{entry.name}</span>
                  <span className="jv-envs-quick-meta">{count > 0 ? `>_ ${count}` : entry.sub}</span>
                </button>;
              })}
            </div>}
          </div> : headerKind ? <EnvKindTile type={headerKind} compact/> : null}
        </>}
        title={collapsed && !adding && headerKind ? "" : headerTitle}
        sub={collapsed && !adding ? undefined : headerSub}
        actions={!adding && selectedEnvId ? <div className="jv-seg jv-envs-tabs" role="radiogroup" aria-label={t("rail.environments")}>
          <button type="button" role="radio" aria-checked={tab === "overview"} onClick={() => switchTab("overview")}>{t("envs.tabOverview")}</button>
          <button type="button" role="radio" aria-checked={tab === "terminal"} onClick={() => switchTab("terminal")}>
            {t("envs.tabTerminal")}{selectedRunning > 0 && <span className="jv-envs-tab-count">{selectedRunning}</span>}
          </button>
          <button type="button" role="radio" aria-checked={tab === "files"} onClick={() => switchTab("files")}>{t("envs.tabFiles")}</button>
        </div> : undefined}/>

      <div className="jv-envs-content">
        {(selectedEnvId || terminals.length > 0) && <EnvironmentTerminals
          environmentId={selectedEnvId ?? ""} platform={device?.platform}
          sessions={selectedSessions} allSessions={terminals} availableShells={availableShells}
          availability={availability} visible={active && showTerminal} maximized={maximized}
          selectedSessionId={activeTerminalId} openRequest={openTermReq}
          onSelectSession={selectTermSession}
          onToggleMaximize={() => setMaximized(value => !value)}
          onRefresh={loadTerminals} onSandboxStarted={refreshBot}/>}
        {showFiles && <EnvironmentFiles environmentId={selectedEnvId} botId={bot?.id} availability={availability}
          maximized={maximized} onToggleMaximize={() => setMaximized(value => !value)}
          onOpenTerminal={openTerminalInDir} onSandboxStarted={refreshBot}/>}
        {!showTerminal && !showFiles && <div className="jv-envs-body">
          <div className="jv-ov-inner">
            {adding && <div className="jv-seg jv-envs-add-kind" role="radiogroup" aria-label={t("machines.add")}>
              {([false, true] as const).map(value => <button key={String(value)} type="button" role="radio" aria-checked={connecting === value} onClick={() => setConnecting(value)}>
                {t(value ? "devices.kindDevice" : "devices.kindMachine")}</button>)}</div>}
            {!adding && <EnvironmentHero device={device} machine={machine} bot={bot} here={here} statuses={statuses}
              runningTerminals={selectedRunning}
              onOpenTerminal={() => switchTab("terminal")} onBrowseFiles={() => switchTab("files")}/>}
            {adding && connecting ? <DeviceConnect/>
              : adding ? <MachineForm onCancel={() => { onAdding(false); setOpen(false); }} onSaved={saved => {
                setMachines(list => [...(list ?? []), saved]); pick({ kind: "machine", id: saved.id });
              }}/>
              : device ? <DeviceDetail key={device.id} device={device} bots={bots}
                onChanged={saved => setDevices(list => list && list.map(item => item.id === saved.id ? saved : item))}
                onDeleted={() => { kept = null; setPicked(null); setOpen(false); setDevices(list => list && list.filter(item => item.id !== device.id)); }}/>
              : machine ? <MachineDetail key={machine.id} machine={machine} bots={bots}
                onChanged={saved => setMachines(list => list && list.map(item => item.id === saved.id ? saved : item))}
                onDeleted={() => { kept = null; setPicked(null); setOpen(false); setMachines(list => list && list.filter(item => item.id !== machine.id)); }}/>
              : bot ? <div className="jv-ov-grid">
                <div className="jv-ov-col"><BotEnvironment key={bot.id} bot={bot} onSaved={onSaved} heading={true} showSpecs={false}/></div>
                <div className="jv-ov-col"><BotPorts key={`ports-${bot.id}`} bot={bot} runs={`${status?.status ?? "stop"}:${status?.runId ?? ""}`}/></div>
              </div> : null}
          </div>
        </div>}
      </div>
    </main>
  </section>;
}
