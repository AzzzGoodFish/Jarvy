import { COMPUTER_CWD } from "../../infra/env/docker.js";
import { hostEnvironment } from "../../infra/env/host.js";
import type { Store } from "../../infra/storage/store.js";
import { ChatError } from "../../shared/chat.js";
import type { EnvironmentRecord, WorkEnvironment } from "../../shared/environment.js";
import type { BotPlacement, HomeKind } from "../../../contract/environment.js";
import type { Computers } from "./computers.js";
import type { SshMachines } from "./machines.js";

/** An environment as a Bot is told of it (A50): what to call it and the directory its tools start in there. A
 * sandbox is what the code calls a `computer`; an SSH machine (A57) is called by the name its owner gave it. */
export interface Place { id: string; kind: "sandbox" | "host" | "ssh"; name: string; directory: string }
/** What an owner's change did to where the Bot works; the service tells the Bot (A41). */
export interface Moved { from: Place; to: Place }

/** What a Bot learns about an environment when it switches there. */
const ABOUT: Record<HomeKind, string> = {
  computer: "A Linux container only you use, with Node, Python, git, build tools, and Playwright with its browsers. You can install software there with sudo; it stays until the owner resets your sandbox, and /workspace, your home there, is kept when it is reset.",
  host: "The machine where this chat platform's server runs. Your tools run there as your owner and can reach their files: work in your directory, and leave other members' workspaces, live data directories (such as ~/.jarvy), main repository checkouts and system directories alone unless the task needs it; say in your reply what you changed there.",
};

interface Opened { id: string; env: WorkEnvironment; view: WorkEnvironment; busy: number; retired: boolean }

/** Where each Bot works (A50): its current environment, looked up at every tool call, so a move takes effect at the
 * next call without a new session. The owner's computer runs the tools in the Bot's workspace; a Bot's sandbox
 * is a container (see Computers). An environment opens on first use; once the Bot is elsewhere it closes when the
 * operations still running there end, so a switch never cuts a command short. Open connections would keep the
 * process alive, so all close when Jarvy stops. */
export class BotEnvironments {
  private readonly open = new Map<string, Opened>();
  constructor(private readonly store: Store, private readonly computers: Computers, private readonly machines: SshMachines) {}

  current(botId: string, workspacePath: string): WorkEnvironment {
    const target = this.store.environments.placement(botId).current, signature = this.signature(target);
    const open = this.open.get(botId);
    if (open?.id === signature) return open.view;
    if (open) this.retire(open);
    const opened = this.track(signature, target.kind === "computer" ? this.computers.environment(target.botId ?? botId, target)
      : target.kind === "ssh" ? this.machines.environment(target, botId) : hostEnvironment(workspacePath));
    this.open.set(botId, opened);
    return opened.view;
  }
  placement(botId: string): BotPlacement {
    const environments = this.store.environments, { home, current } = environments.placement(botId);
    const hostId = environments.host().id, granted = new Set(environments.grants(botId).map(grant => grant.id));
    return { home: home.kind === "computer" ? "computer" : "host", current: current.kind, ...(current.kind === "ssh" ? { currentName: current.name } : {}),
      computer: this.computers.status(botId), docker: this.computers.available, hostGranted: granted.has(hostId),
      machines: environments.sshMachines().map(machine => ({ id: machine.id, name: machine.name, granted: granted.has(machine.id) })) };
  }
  /** The environments the Bot may be in: its sandbox, its default, and the ones its owner granted it. */
  usable(botId: string): EnvironmentRecord[] {
    const environments = this.store.environments;
    const all = [environments.computerOf(botId), environments.placement(botId).home, ...environments.grants(botId)];
    return [...new Map(all.filter((record): record is EnvironmentRecord => !!record).map(record => [record.id, record])).values()];
  }
  place(botId: string, record: EnvironmentRecord, workspacePath: string): Place {
    if (record.kind === "host") return { id: record.id, kind: "host", name: "your owner's computer", directory: workspacePath };
    if (record.kind === "ssh") return { id: record.id, kind: "ssh", name: record.name, directory: record.directory ?? record.spec.home ?? "/" };
    return { id: record.id, kind: "sandbox", name: record.botId === botId ? "your sandbox" : "another Bot's sandbox", directory: COMPUTER_CWD };
  }
  /** A Bot's environments as other Bots see them in bots.list. */
  summary(botId: string) {
    const name = (record: EnvironmentRecord) => record.kind === "host" ? "owner's computer" : record.kind === "ssh" ? record.name
      : record.botId === botId ? "own sandbox" : "another Bot's sandbox";
    const { home, current } = this.store.environments.placement(botId);
    return { default: name(home), current: name(current), usable: this.usable(botId).map(name) };
  }
  /** The Bot's default environment, which its instructions describe. */
  home(botId: string, workspacePath: string): Place { return this.place(botId, this.store.environments.placement(botId).home, workspacePath); }
  /** Where the Bot works now, for the end of each batch. */
  here(botId: string, workspacePath: string): Place { return this.place(botId, this.store.environments.placement(botId).current, workspacePath); }
  /** environments.list: where the Bot is and where else it may go. */
  list(botId: string, workspacePath: string) {
    const { home, current } = this.store.environments.placement(botId);
    return { current: current.id, environments: this.usable(botId).map(record => ({ ...this.place(botId, record, workspacePath),
      ...(record.id === home.id ? { default: true } : {}), ...(record.kind === "computer" ? { state: this.computers.status(record.botId ?? botId)?.state ?? "stopped" } : {}),
      ...(record.kind === "ssh" ? { address: this.machines.address(record), ...(record.description ? { description: record.description } : {}) } : {}) })) };
  }
  /** environments.switch: the Bot moves itself, like cd, until it switches back. A sandbox is started first, an SSH
   * machine connected first; if that fails, the Bot stays where it was. */
  async switch(botId: string, environmentId: string, workspacePath: string) {
    const target = this.usable(botId).find(record => record.id === environmentId);
    if (!target) throw new ChatError(404, "No work environment with this id that you may use; see environments.list");
    const previous = this.store.environments.placement(botId).current, already = previous.id === target.id;
    if (target.kind === "computer") await this.computers.ensure(target.botId ?? botId);
    this.store.environments.setCurrent(botId, target.id);
    if (target.kind === "ssh" && !already) {
      const place = this.place(botId, target, workspacePath);
      try { if (!await this.current(botId, workspacePath).exists(place.directory)) throw new Error(`${place.directory} doesn't exist there; ask your owner to change the machine's directory, or switch back`); }
      catch (error) {
        const opened = this.open.get(botId);
        if (opened) { this.open.delete(botId); this.retire(opened); }
        this.store.environments.setCurrent(botId, previous.id);
        throw new ChatError(409, `Couldn't connect to ${target.name}, so you stay where you were: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ...this.place(botId, target, workspacePath), about: target.kind === "ssh" ? this.machines.about(target, botId) : ABOUT[target.kind],
      ...(already ? { note: "You were already here." } : {}) };
  }
  /** The owner makes the Bot's sandbox (given it on first use) or their computer its default, and moves it there. */
  setHome(botId: string, kind: HomeKind, workspacePath: string): Moved | null {
    const environments = this.store.environments, from = this.here(botId, workspacePath);
    if (kind === "host") environments.setHome(botId, environments.host().id);
    else {
      const computer = environments.computerOf(botId);
      if (computer) { environments.setHome(botId, computer.id); void this.computers.ensure(botId).catch(() => {}); }
      else this.computers.create(botId);
    }
    const to = this.here(botId, workspacePath);
    return from.id === to.id ? null : { from, to };
  }
  /** The owner grants or takes back their computer (A50) or an SSH machine (A57); taking it back while the Bot works
   * there sends it home. */
  grant(botId: string, environmentId: string | "host", granted: boolean, by: string, workspacePath: string): { changed: boolean; moved: Moved | null; name: string } {
    const environments = this.store.environments, target = environmentId === "host" ? environments.host() : environments.get(environmentId);
    if (!target || target.kind === "computer") throw new ChatError(404, "No such environment");
    const name = this.place(botId, target, workspacePath).name;
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
  private signature(record: EnvironmentRecord): string { return record.kind === "ssh" ? `${record.id}@${record.directory ?? ""}` : record.id; }
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
      id: env.id, kind: env.kind, cwd: env.cwd, ...(env.temp ? { temp: env.temp } : {}),
      exec: (command, options) => run(() => env.exec(command, options)),
      readFile: path => run(() => env.readFile(path)),
      head: (path, bytes) => run(() => env.head(path, bytes)),
      writeFile: (path, content) => run(() => env.writeFile(path, content)),
      mkdir: path => run(() => env.mkdir(path)),
      exists: path => run(() => env.exists(path)),
      fileSize: path => run(() => env.fileSize(path)),
      close: () => env.close(),
    };
    return opened;
  }
}
