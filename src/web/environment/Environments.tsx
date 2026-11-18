import { useEffect, useState } from "react";
import { ChevronLeftIcon, ContainerIcon, LaptopIcon, MonitorIcon, Search, ServerIcon } from "lucide-react";
import { api } from "../api";
import type { Bot, BotStatus } from "../../contract/bots";
import type { Device, SshMachine } from "../../contract/environment";
import { BotAvatar } from "../avatar/BotAvatar";
import { errorText } from "../errors";
import { BotPorts } from "../ports/BotPorts";
import { IconButton } from "../ui";
import { ColumnHeader } from "../components/column-header";
import { ListRow } from "../components/list-row";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { t } from "../i18n";
import { BotEnvironment, STATE } from "./BotEnvironment";
import { MachineDetail, machineAddress } from "./MachineDetail";
import { MachineForm } from "./MachineForm";
import { DeviceConnect, DeviceDetail, deviceState, deviceSystem } from "./DeviceDetail";
import "../styles/model-workbench.css";
import "../styles/secrets.css";
import "../styles/machines.css";
import "../styles/environments.css";

/** What the page shows on the right: a sandbox (by its Bot), a machine, or the form to add one. */
type Picked = { kind: "sandbox" | "machine" | "device"; id: string };
/** The pick, kept while the page is away (the chats, the agent Bot's page) and lost on a reload. */
let kept: Picked | null = null;
/** Avatars shown on a row before the rest are counted. */
const FACES = 3;

/** The Environments page (A89): every place Bots work, one row each, the machines added over SSH (A57) first and then
 * each Bot's sandbox (A50, A85) with its state; every row shows the Bots working there now, so a Bot that switched to a
 * machine is on the machine's row. On the right the one picked: a sandbox as Bot info shows it, with its ports (A74),
 * or a machine with what Settings showed of it before. `adding` opens the form to add a machine (Bot info's 授权 tab
 * asks for it). On a phone the list fills the screen and a pick opens over it. */
export function Environments({ bots, statuses, adding, onAdding, onSaved }: {
  bots: Bot[]; statuses: Record<string, BotStatus>; adding: boolean; onAdding: (adding: boolean) => void; onSaved: (bot: Bot) => void;
}) {
  const [machines, setMachines] = useState<SshMachine[] | null>(null), [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null), [connecting, setConnecting] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(kept), [open, setOpen] = useState(adding), [filter, setFilter] = useState("");
  useEffect(() => { void api.machines().then(view => setMachines(view.machines)).catch(reason => setError(errorText(reason))); }, []);
  // A computer comes online, goes away or is added from its own side, so the list is asked again now and then.
  useEffect(() => {
    let alive = true;
    const load = () => void api.devices().then(view => { if (alive) setDevices(view.devices); }).catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => { if (adding) setOpen(true); }, [adding]);
  const sandboxes = bots.filter(bot => bot.environment.computer);
  // Machine names are unique, so the one a Bot says it works on is this one.
  const on = (machine: SshMachine) => bots.filter(bot => bot.environment.current === "ssh" && bot.environment.currentName === machine.name);
  const at = (device: Device) => bots.filter(bot => bot.environment.current === "device" && bot.environment.currentName === device.name);
  const home = (bot: Bot) => bot.environment.current === "computer" ? [bot] : [];
  const chosenMachine = picked?.kind === "machine" ? machines?.find(item => item.id === picked.id) : undefined;
  const chosenSandbox = picked?.kind === "sandbox" ? sandboxes.find(bot => bot.id === picked.id) : undefined;
  const chosenDevice = picked?.kind === "device" ? devices?.find(item => item.id === picked.id) : undefined;
  // Nothing picked, or what was picked is gone: the first row, once the machines are known.
  const none = !chosenMachine && !chosenSandbox && !chosenDevice;
  const device = adding ? undefined : chosenDevice ?? (none ? devices?.[0] : undefined);
  const machine = adding || device ? undefined : chosenMachine ?? (none ? machines?.[0] : undefined);
  const bot = adding || machine || device ? undefined : chosenSandbox ?? (none && (machines || error) ? sandboxes[0] : undefined);
  const pick = (next: Picked) => { kept = next; setPicked(next); onAdding(false); setOpen(true); };
  const here = device ? at(device) : machine ? on(machine) : bot ? home(bot) : [];
  const status = bot && statuses[bot.id];
  const faces = (list: Bot[]) => <Faces bots={list} statuses={statuses}/>;
  // The search box, as the chat list's: a computer by its name or system, a machine by its name or address, a sandbox by its Bot's name.
  const query = filter.trim().toLocaleLowerCase(), found = (text: string) => text.toLocaleLowerCase().includes(query);
  const shownMachines = machines?.filter(item => found(`${item.name} ${machineAddress(item)}`));
  const shownDevices = devices?.filter(item => found(`${item.name} ${deviceSystem(item)}`));
  const shownSandboxes = sandboxes.filter(item => found(`${item.name} ${t("envs.sandboxOf", { name: item.name })}`));
  return <section className="jv-envs" data-open={open || undefined} aria-label={t("rail.environments")}>
    <aside className="jv-envs-list">
      <ColumnHeader place="sidebar" title={<span className="sr-only">{t("rail.environments")}</span>}
        actions={<IconButton icon="add" label={t("machines.add")} aria-pressed={adding} onClick={() => { onAdding(true); setOpen(true); }}/>}/>
      <div className="mx-3 mt-1 mb-2 shrink-0" role="search">
        <InputGroup className="h-9 bg-background">
          <InputGroupInput type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("envs.search")} aria-label={t("envs.search")}
            onKeyDown={event => { if (event.key === "Escape" && filter) { event.preventDefault(); setFilter(""); } }} className="text-sm"/>
          <InputGroupAddon align="inline-start"><Search aria-hidden="true"/></InputGroupAddon>
        </InputGroup>
      </div>
      <div className="jv-envs-scroll">
        {shownDevices?.map(item => <ListRow key={item.id} active={device?.id === item.id} onClick={() => pick({ kind: "device", id: item.id })}
          leading={<Kind type="device"/>} title={item.name} sub={deviceSystem(item) || t("devices.kindDevice")}
          trailing={<>{faces(at(item))}<DeviceDot device={item}/></>}/>)}
        {shownMachines?.map(item => <ListRow key={item.id} active={machine?.id === item.id} onClick={() => pick({ kind: "machine", id: item.id })}
          leading={<Kind type="ssh"/>} title={item.name} sub={<span className="jv-mono">{machineAddress(item)}</span>}
          trailing={<>{faces(on(item))}<span className="jv-envs-state"/></>}/>)}
        {shownSandboxes.map(item => {
          const computer = item.environment.computer!;
          return <ListRow key={item.id} active={bot?.id === item.id} onClick={() => pick({ kind: "sandbox", id: item.id })}
            leading={<Kind type={computer.type}/>} title={t("envs.sandboxOf", { name: item.name })}
            sub={t(computer.type === "vm" ? "environment.type.vm" : "environment.type.container")}
            trailing={<>{faces(home(item))}
              <span className="jv-envs-state" data-state={computer.state} role="img" aria-label={t(STATE[computer.state])} title={t(STATE[computer.state])}/></>}/>;
        })}
        {query && machines && !shownMachines?.length && !shownDevices?.length && !shownSandboxes.length && <p className="jv-envs-none">{t("envs.noMatch")}</p>}
        {error && <p className="jv-note-error" role="alert">{error}</p>}
      </div>
    </aside>
    <main className="jv-envs-detail jv-ui">
      <ColumnHeader place="content" as="h2"
        leading={<><button type="button" className="jv-envs-back" aria-label={t("envs.back")} onClick={() => { setOpen(false); onAdding(false); }}><ChevronLeftIcon aria-hidden="true"/></button>
          {device ? <Kind type="device"/> : machine ? <Kind type="ssh"/> : bot ? <Kind type={bot.environment.computer!.type}/> : null}</>}
        title={adding ? t(connecting ? "devices.connect" : "machines.add") : device ? device.name : machine ? machine.name : bot ? t("envs.sandboxOf", { name: bot.name }) : ""}
        sub={device ? deviceSystem(device) : machine ? <span className="jv-mono">{machineAddress(machine)}</span> : undefined}/>
      <div className="jv-envs-body">
        {!adding && here.length > 0 && <p className="jv-envs-here">{faces(here)}{t("envs.workingHere", { names: here.map(item => item.name).join(t("common.listSeparator")), count: here.length })}</p>}
        {adding && <div className="jv-seg jv-envs-add-kind" role="radiogroup" aria-label={t("machines.add")}>
          {([false, true] as const).map(value => <button key={String(value)} type="button" role="radio" aria-checked={connecting === value} onClick={() => setConnecting(value)}>
            {t(value ? "devices.kindDevice" : "devices.kindMachine")}</button>)}</div>}
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
          : bot ? <><BotEnvironment key={bot.id} bot={bot} onSaved={onSaved} heading={false}/><BotPorts key={`ports-${bot.id}`} bot={bot} runs={`${status?.status ?? "stop"}:${status?.runId ?? ""}`}/></> : null}
      </div>
    </main>
  </section>;
}

/** What kind of place it is: a container, a VM (A85) or a machine over SSH. */
function Kind({ type }: { type: "container" | "vm" | "ssh" | "device" }) {
  const Icon = type === "device" ? LaptopIcon : type === "ssh" ? ServerIcon : type === "vm" ? MonitorIcon : ContainerIcon;
  return <span className="ui-tile" data-kind={type}><Icon aria-hidden="true"/></span>;
}

/** A computer's dot: green online, amber paused in its client, grey offline. */
function DeviceDot({ device }: { device: Device }) {
  const state = deviceState(device), label = t(`devices.${state}`);
  return <span className="jv-envs-state" data-state={state === "online" ? "running" : state === "paused" ? "preparing" : "stopped"} role="img" aria-label={label} title={label}/>;
}

/** The Bots working in a place now, overlapping, a stopped one asleep (A88); past three, how many more. */
function Faces({ bots, statuses }: { bots: Bot[]; statuses: Record<string, BotStatus> }) {
  return <span className="jv-envs-faces" title={bots.map(bot => bot.name).join(t("common.listSeparator")) || undefined}>
    {bots.slice(0, FACES).map(bot => <BotAvatar key={bot.id} color={bot.color} mood={bot.mood} size={22} crown={bot.agent} asleep={statuses[bot.id]?.status === "stop"}/>)}
    {bots.length > FACES && <span className="jv-envs-more">+{bots.length - FACES}</span>}
  </span>;
}
