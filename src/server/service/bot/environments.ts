import type { Store } from "../../infra/storage/store.js";
import { ChatError } from "../../shared/chat.js";
import type { EnvironmentRecord, WorkEnvironment } from "../../shared/environment.js";
import type { BotPlacement } from "../../../contract/environment.js";
import type { Computers } from "./computers.js";
import type { SshMachines } from "./machines.js";
import { KINDS } from "./kinds/index.js";
import { AGENT_BOT_ID } from "../../shared/models.js";
import type { KindDeps } from "./kinds/kind.js";

/** An environment as a Bot is told of it (A50): what to call it and the directory its tools start in there. A
 * sandbox is what the code calls a `computer`; an SSH machine (A57) is called by the name its owner gave it. */
export interface Place { id: string; kind: "sandbox" | "ssh"; name: string; directory: string }
/** What an owner's change did to where the Bot works; the service tells the Bot (A41). */
export interface Moved { from: Place; to: Place }

interface Opened { id: string; env: WorkEnvironment; view: WorkEnvironment; busy: number; retired: boolean }

/** Where each Bot works (A50): its current environment, looked up at every tool call, so a move takes effect at the
 * next call without a new session. A Bot's sandbox is a container (see Computers); an SSH machine is reached with
 * pi-env (see SshMachines). An environment opens on first use; once the Bot is elsewhere it closes when the
 * operations still running there end, so a switch never cuts a command short. Open connections would keep the
 * process alive, so all close when Jarvy stops. */
export class BotEnvironments {
  private readonly open = new Map<string, Opened>();
  private readonly kinds: KindDeps;
  constructor(private readonly store: Store, private readonly computers: Computers, machines: SshMachines) {
    this.kinds = { computers, machines };
  }

  current(botId: string, workspacePath: string): WorkEnvironment {
    const target = this.settled(botId), signature = this.signature(target);
    const open = this.open.get(botId);
    if (open?.id === signature) return open.view;
    if (open) this.retire(open);
    const opened = this.track(signature, KINDS[target.kind].open(target, botId, workspacePath, this.kinds));
    this.open.set(botId, opened);
    return opened.view;
  }
  placement(botId: string): BotPlacement {
    const environments = this.store.environments, current = this.settled(botId);
    const granted = new Set(environments.grants(botId).map(grant => grant.id)), once = environments.onceGrants(botId);
    const mark = (id: string) => ({ granted: granted.has(id), ...(once.has(id) ? { once: true as const } : {}) });
    return { current: current.kind, ...(current.kind === "ssh" ? { currentName: current.name } : {}),
      computer: this.computers.info(botId), docker: this.computers.available,
      machines: environments.sshMachines().map(machine => ({ id: machine.id, name: machine.name, ...mark(machine.id) })),
      // The agent Bot may be let into other Bots' sandboxes (A93).
      ...(botId === AGENT_BOT_ID ? { sandboxes: this.othersSandboxes(botId).map(record => ({ id: record.id, name: this.botName(record), ...mark(record.id) })) } : {}) };
  }
  /** Drops expired single-run grants and brings the Bot home if needed; true when anything changed (A93). */
  expireOnce(botId: string): boolean {
    const dropped = this.store.environments.pruneOnce(botId), before = this.store.environments.placement(botId).current.id;
    return this.settled(botId).id !== before || dropped;
  }
  /** Where the Bot is, unless that was a grant for a run that has ended (A93): then it is back home. */
  private settled(botId: string): EnvironmentRecord {
    const { home, current } = this.store.environments.placement(botId);
    if (current.id === home.id || (current.kind === "computer" && current.botId === botId) || this.usable(botId).some(record => record.id === current.id)) return current;
    this.store.environments.setCurrent(botId, home.id);
    return home;
  }
  /** Other Bots' sandboxes, for the agent Bot (A93). */
  private othersSandboxes(botId: string): EnvironmentRecord[] {
    return this.store.environments.computers().filter(record => record.botId !== botId && this.store.bots.get(record.botId ?? ""));
  }
  private botName(record: EnvironmentRecord): string { return this.store.bots.get(record.botId ?? "")?.name ?? "another Bot"; }
  /** What the owner may give a Bot: an SSH machine (A57), and to the agent Bot another Bot's sandbox (A93). */
  private grantableTo(botId: string, record: EnvironmentRecord): boolean {
    return KINDS[record.kind].grantable || (botId === AGENT_BOT_ID && record.kind === "computer" && record.botId !== botId);
  }
  /** An environment the agent Bot may go to once its owner allows it on a card (A93): another Bot's sandbox, or an SSH
   * machine not granted to it; null when it may already go there, or for any other Bot. */
  waiting(botId: string, environmentId: string): EnvironmentRecord | null {
    if (botId !== AGENT_BOT_ID || this.usable(botId).some(record => record.id === environmentId)) return null;
    const record = this.store.environments.get(environmentId);
    return record && this.grantableTo(botId, record) ? record : null;
  }
  /** The owner allowed it on the agent's card: until revoked, or for the run it is in (A93). */
  allow(botId: string, environmentId: string, by: string, runId?: string): void {
    const record = this.waiting(botId, environmentId);
    if (record) this.store.environments.grant(record.id, botId, by, runId);
  }
  /** What the agent's card and log call an environment. */
  label(botId: string, record: EnvironmentRecord): string { return record.kind === "computer" && record.botId !== botId ? `${this.botName(record)}'s sandbox` : record.name; }
  /** Structured target for the agent's entry card (A93), or null if it already has access. */
  enterTarget(botId: string, environmentId: string): { label: string; enter: { kind: "sandbox" | "machine"; name: string; address?: string } } | null {
    const record = this.waiting(botId, environmentId);
    if (!record) return null;
    return record.kind === "computer"
      ? { label: this.label(botId, record), enter: { kind: "sandbox", name: this.botName(record) } }
      : { label: record.name, enter: { kind: "machine", name: record.name, address: `${record.spec.user}@${record.spec.host}${record.spec.port === "22" ? "" : `:${record.spec.port}`}` } };
  }
  /** When a Bot goes, anyone (the agent) working in its sandbox goes back home. */
  async releaseComputer(deletedBotId: string): Promise<void> {
    const computer = this.store.environments.computerOf(deletedBotId);
    if (!computer) return;
    for (const [botId, open] of this.open) if (open.id === this.signature(computer)) await this.release(botId);
    const { home, current } = this.store.environments.placement(AGENT_BOT_ID);
    if (current.id === computer.id) this.store.environments.setCurrent(AGENT_BOT_ID, home.id);
  }
  /** The environments the Bot may be in: its sandbox, its default, and the ones its owner granted it. */
  usable(botId: string): EnvironmentRecord[] {
    const environments = this.store.environments;
    const all = [environments.computerOf(botId), environments.placement(botId).home, ...environments.grants(botId)];
    return [...new Map(all.filter((record): record is EnvironmentRecord => !!record).map(record => [record.id, record])).values()];
  }
  place(botId: string, record: EnvironmentRecord, workspacePath: string): Place { return KINDS[record.kind].place(record, botId, workspacePath); }
  /** A Bot's environments as other Bots see them in bots.list. */
  summary(botId: string) {
    const name = (record: EnvironmentRecord) => KINDS[record.kind].summary(record, botId);
    const { home, current } = this.store.environments.placement(botId);
    return { default: name(home), current: name(current), usable: this.usable(botId).map(name) };
  }
  /** The Bot's default environment (A68): its own sandbox. */
  default(botId: string, workspacePath: string): Place { return this.place(botId, this.store.environments.placement(botId).home, workspacePath); }
  /** Where the Bot works now, for the end of each batch. */
  here(botId: string, workspacePath: string): Place { return this.place(botId, this.store.environments.placement(botId).current, workspacePath); }
  /** environments.list: where the Bot is, where else it may go, and the owner's machines it may not use yet, so it
   * knows what to ask for. */
  list(botId: string, workspacePath: string) {
    const { home } = this.store.environments.placement(botId), current = this.settled(botId), usable = this.usable(botId), mine = new Set(usable.map(record => record.id));
    const agent = botId === AGENT_BOT_ID;
    const others = [...this.store.environments.sshMachines(), ...(agent ? this.othersSandboxes(botId) : [])].filter(record => !mine.has(record.id));
    const entry = (record: EnvironmentRecord, granted: boolean) => ({ ...this.place(botId, record, workspacePath), ...(record.id === home.id ? { default: true } : {}),
      ...(record.kind === "computer" && record.botId !== botId ? { bot: this.botName(record) } : {}),
      ...(this.grantableTo(botId, record) ? { granted } : {}), ...KINDS[record.kind].describe(record, botId, this.kinds) });
    return { current: current.id, environments: [...usable.map(record => entry(record, true)), ...others.map(record => entry(record, false))],
      ...(others.length ? { note: agent ? "granted=false: use environments.enter with its id to ask your owner on a card (another Bot's sandbox is that Bot's workspace: work there only as far as the task needs)."
        : "granted=false: your owner's, but you may not use it. Ask for it with environments.request and its id; your owner only has to allow it." } : {}) };
  }
  /** environments.switch: the Bot moves itself, like cd, until it switches back. A sandbox is started first, an SSH
   * machine connected first; if that fails, the Bot stays where it was. */
  async switch(botId: string, environmentId: string, workspacePath: string) {
    const target = this.usable(botId).find(record => record.id === environmentId);
    if (!target) {
      const owners = this.store.environments.get(environmentId);
      if (owners && this.grantableTo(botId, owners)) throw new ChatError(403, botId === AGENT_BOT_ID ? `Your owner hasn't allowed ${this.label(botId, owners)} yet: ask them with environments.enter and id ${owners.id}`
        : `You may not use ${owners.name} yet: ask your owner for it with environments.request and id ${owners.id}`);
      throw new ChatError(404, "No work environment with this id; see environments.list");
    }
    const previous = this.store.environments.placement(botId).current, already = previous.id === target.id, entry = KINDS[target.kind];
    await entry.ensure?.(target, botId, this.kinds);
    this.store.environments.setCurrent(botId, target.id);
    if (entry.connects && !already) {
      const place = this.place(botId, target, workspacePath);
      try { if (!await this.current(botId, workspacePath).exists(place.directory)) throw new Error(`${place.directory} doesn't exist there; ask your owner to change the machine's directory, or switch back`); }
      catch (error) {
        const opened = this.open.get(botId);
        if (opened) { this.open.delete(botId); this.retire(opened); }
        this.store.environments.setCurrent(botId, previous.id);
        throw new ChatError(409, `Couldn't connect to ${target.name}, so you stay where you were: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ...this.place(botId, target, workspacePath), about: entry.about(target, botId, this.kinds),
      ...(already ? { note: "You were already here." } : {}) };
  }
  /** The owner grants or takes back an SSH machine (A57); taking it back while the Bot works there sends it home. */
  grant(botId: string, environmentId: string, granted: boolean, by: string, workspacePath: string): { changed: boolean; moved: Moved | null; name: string } {
    const environments = this.store.environments, target = environments.get(environmentId);
    if (!target || !this.grantableTo(botId, target)) throw new ChatError(404, "No such environment");
    const name = this.label(botId, target);
    if (granted) return { changed: environments.grant(target.id, botId, by), moved: null, name };
    const changed = environments.revoke(target.id, botId), { home, current } = environments.placement(botId);
    if (current.id !== target.id || home.id === target.id) return { changed, moved: null, name };
    const from = this.here(botId, workspacePath);
    environments.setCurrent(botId, home.id);
    return { changed, moved: { from, to: this.here(botId, workspacePath) }, name };
  }
  async release(botId: string): Promise<void> {
    const open = this.open.get(botId);
    this.open.delete(botId);
    await open?.env.close();
    await this.computers.remove(botId);
  }
  async close(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map(open => open.env.close()));
    await this.computers.close();
  }

  /** What an open environment is for: changing a machine's directory reopens it where the owner put it. */
  private signature(record: EnvironmentRecord): string { return KINDS[record.kind].signature(record); }
  private retire(open: Opened) {
    open.retired = true;
    if (!open.busy) void open.env.close();
  }
  /** Counts the operations running on an environment, so one the Bot has left closes only when they are done. */
  private track(id: string, env: WorkEnvironment): Opened {
    const opened: Opened = { id, env, view: env, busy: 0, retired: false };
    const run = async <T>(work: () => Promise<T>): Promise<T> => {
      opened.busy++;
      try { return await work(); }
      finally { if (--opened.busy === 0 && opened.retired) void env.close(); }
    };
    opened.view = {
      id: env.id, kind: env.kind, local: env.local, cwd: env.cwd, ...(env.temp ? { temp: env.temp } : {}),
      exec: (command, options) => run(() => env.exec(command, options)),
      readFile: path => run(() => env.readFile(path)),
      head: (path, bytes) => run(() => env.head(path, bytes)),
      readRange: (path, offset, length) => run(() => env.readRange(path, offset, length)),
      writeFile: (path, content) => run(() => env.writeFile(path, content)),
      appendFile: (path, content) => run(() => env.appendFile(path, content)),
      mkdir: path => run(() => env.mkdir(path)),
      exists: path => run(() => env.exists(path)),
      fileSize: path => run(() => env.fileSize(path)),
      close: () => env.close(),
    };
    return opened;
  }
}
