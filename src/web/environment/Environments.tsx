import { useEffect, useState } from "react";
import { ChevronLeftIcon, ContainerIcon, MonitorIcon, ServerIcon } from "lucide-react";
import { api } from "../api";
import type { Bot, BotStatus } from "../../contract/bots";
import type { SshMachine } from "../../contract/environment";
import { BotAvatar } from "../avatar/BotAvatar";
import { errorText } from "../errors";
import { BotPorts } from "../ports/BotPorts";
import { IconButton } from "../ui";
import { t } from "../i18n";
import { BotEnvironment, STATE } from "./BotEnvironment";
import { MachineDetail, machineAddress } from "./MachineDetail";
import { MachineForm } from "./MachineForm";
import "../styles/model-workbench.css";
import "../styles/secrets.css";
import "../styles/machines.css";
import "../styles/environments.css";

/** What the page shows on the right: a sandbox (by its Bot), a machine, or the form to add one. */
type Picked = { kind: "sandbox" | "machine"; id: string };
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
  const [picked, setPicked] = useState<Picked | null>(kept), [open, setOpen] = useState(adding);
  useEffect(() => { void api.machines().then(view => setMachines(view.machines)).catch(reason => setError(errorText(reason))); }, []);
  useEffect(() => { if (adding) setOpen(true); }, [adding]);
  const sandboxes = bots.filter(bot => bot.environment.computer);
  // Machine names are unique, so the one a Bot says it works on is this one.
  const on = (machine: SshMachine) => bots.filter(bot => bot.environment.current === "ssh" && bot.environment.currentName === machine.name);
  const home = (bot: Bot) => bot.environment.current === "computer" ? [bot] : [];
  const chosenMachine = picked?.kind === "machine" ? machines?.find(item => item.id === picked.id) : undefined;
  const chosenSandbox = picked?.kind === "sandbox" ? sandboxes.find(bot => bot.id === picked.id) : undefined;
  // Nothing picked, or what was picked is gone: the first row, once the machines are known.
  const none = !chosenMachine && !chosenSandbox;
  const machine = adding ? undefined : chosenMachine ?? (none ? machines?.[0] : undefined);
  const bot = adding || machine ? undefined : chosenSandbox ?? (none && (machines || error) ? sandboxes[0] : undefined);
  const pick = (next: Picked) => { kept = next; setPicked(next); onAdding(false); setOpen(true); };
  const here = machine ? on(machine) : bot ? home(bot) : [];
  const status = bot && statuses[bot.id];
  const faces = (list: Bot[]) => <Faces bots={list} statuses={statuses}/>;
  return <section className="jv-envs" data-open={open || undefined} aria-label={t("rail.environments")}>
    <aside className="jv-envs-list">
      <header className="jv-envs-list-head"><h2>{t("rail.environments")}</h2>
        <IconButton icon="add" label={t("machines.add")} aria-pressed={adding} onClick={() => { onAdding(true); setOpen(true); }}/></header>
      <div className="jv-envs-scroll">
        {machines?.map(item => <button key={item.id} type="button" className="jv-envs-row" aria-current={machine?.id === item.id || undefined} onClick={() => pick({ kind: "machine", id: item.id })}>
          <Kind type="ssh"/>
          <span className="jv-envs-text"><strong>{item.name}</strong><span className="jv-mono">{machineAddress(item)}</span></span>
          {faces(on(item))}<span className="jv-envs-state"/>
        </button>)}
        {sandboxes.map(item => {
          const computer = item.environment.computer!;
          return <button key={item.id} type="button" className="jv-envs-row" aria-current={bot?.id === item.id || undefined} onClick={() => pick({ kind: "sandbox", id: item.id })}>
            <Kind type={computer.type}/>
            <span className="jv-envs-text"><strong>{t("envs.sandboxOf", { name: item.name })}</strong>
              <span>{t(computer.type === "vm" ? "environment.type.vm" : "environment.type.container")}</span></span>
            {faces(home(item))}
            <span className="jv-envs-state" data-state={computer.state} role="img" aria-label={t(STATE[computer.state])} title={t(STATE[computer.state])}/>
          </button>;
        })}
        {error && <p className="jv-note-error" role="alert">{error}</p>}
      </div>
    </aside>
    <main className="jv-envs-detail jv-ui">
      <header className="jv-envs-head">
        <button type="button" className="jv-envs-back" aria-label={t("envs.back")} onClick={() => { setOpen(false); onAdding(false); }}><ChevronLeftIcon aria-hidden="true"/></button>
        {adding ? <h2>{t("machines.add")}</h2>
          : machine ? <><Kind type="ssh"/><h2>{machine.name}</h2><span className="jv-envs-sub jv-mono">{machineAddress(machine)}</span></>
          : bot ? <><Kind type={bot.environment.computer!.type}/><h2>{t("envs.sandboxOf", { name: bot.name })}</h2></> : null}
      </header>
      <div className="jv-envs-body">
        {!adding && here.length > 0 && <p className="jv-envs-here">{faces(here)}{t("envs.workingHere", { names: here.map(item => item.name).join(t("common.listSeparator")), count: here.length })}</p>}
        {adding ? <MachineForm onCancel={() => { onAdding(false); setOpen(false); }} onSaved={saved => {
          setMachines(list => [...(list ?? []), saved]); pick({ kind: "machine", id: saved.id });
        }}/>
          : machine ? <MachineDetail key={machine.id} machine={machine} bots={bots}
            onChanged={saved => setMachines(list => list && list.map(item => item.id === saved.id ? saved : item))}
            onDeleted={() => { kept = null; setPicked(null); setOpen(false); setMachines(list => list && list.filter(item => item.id !== machine.id)); }}/>
          : bot ? <><BotEnvironment key={bot.id} bot={bot} onSaved={onSaved} heading={false}/><BotPorts key={`ports-${bot.id}`} bot={bot} runs={`${status?.status ?? "stop"}:${status?.runId ?? ""}`}/></> : null}
      </div>
    </main>
  </section>;
}

/** What kind of place it is: a container, a VM (A85) or a machine over SSH. */
function Kind({ type }: { type: "container" | "vm" | "ssh" }) {
  const Icon = type === "ssh" ? ServerIcon : type === "vm" ? MonitorIcon : ContainerIcon;
  return <span className="jv-envs-icon" data-kind={type}><Icon aria-hidden="true"/></span>;
}

/** The Bots working in a place now, overlapping, a stopped one asleep (A88); past three, how many more. */
function Faces({ bots, statuses }: { bots: Bot[]; statuses: Record<string, BotStatus> }) {
  return <span className="jv-envs-faces" title={bots.map(bot => bot.name).join(t("common.listSeparator")) || undefined}>
    {bots.slice(0, FACES).map(bot => <BotAvatar key={bot.id} color={bot.color} mood={bot.mood} size={22} crown={bot.agent} asleep={statuses[bot.id]?.status === "stop"}/>)}
    {bots.length > FACES && <span className="jv-envs-more">+{bots.length - FACES}</span>}
  </span>;
}
