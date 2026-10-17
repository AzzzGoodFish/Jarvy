import { COMPUTER_CWD } from "../../infra/env/docker.js";
import { hostEnvironment } from "../../infra/env/host.js";
import type { Store } from "../../infra/storage/store.js";
import { ChatError } from "../../shared/chat.js";
import type { BotPlacement, EnvironmentKind, EnvironmentRecord, WorkEnvironment } from "../../shared/environment.js";
import type { Computers } from "./computers.js";

/** An environment as a Bot is told of it (A50): what to call it and the directory its tools start in there. */
/** An environment as the Bot reads it: a sandbox is what the code calls a `computer` (fish m1040–m1042). */
export interface Place { id: string; kind: "sandbox" | "host"; name: string; directory: string }
/** What an owner's change did to where the Bot works; the service tells the Bot (A41). */
export interface Moved { from: Place; to: Place }

/** What a Bot learns about an environment when it switches there. */
const ABOUT: Record<EnvironmentKind, string> = {
  computer: "A Linux container only you use, with Node, Python, git, build tools, and Playwright with its browsers. You can install software there with sudo; it stays until the owner resets your sandbox, and /workspace, your home there, is kept when it is reset.",
  host: "The machine running Jarvy. Your tools run there as your owner and can reach their files: work in your directory, and leave other members' workspaces, live data directories (such as ~/.jarvy), main repository checkouts and system directories alone unless the task needs it; say in your reply what you changed there.",
};

interface Opened { id: string; env: WorkEnvironment; view: WorkEnvironment; busy: number; retired: boolean }

/** Where each Bot works (A50): its current environment, looked up at every tool call, so a move takes effect at the
 * next call without a new session. The owner's computer runs the tools in the Bot's workspace; a Bot's sandbox
 * is a container (see Computers). An environment opens on first use; once the Bot is elsewhere it closes when the
 * operations still running there end, so a switch never cuts a command short. Open connections would keep the
 * process alive, so all close when Jarvy stops. */
export class BotEnvironments {
  private readonly open = new Map<string, Opened>();
  constructor(private readonly store: Store, private readonly computers: Computers) {}

  current(botId: string, workspacePath: string): WorkEnvironment {
    const target = this.store.environments.placement(botId).current;
    const open = this.open.get(botId);
    if (open?.id === target.id) return open.view;
    if (open) this.retire(open);
    const opened = this.track(target.id, target.kind === "computer" ? this.computers.environment(target.botId ?? botId, target) : hostEnvironment(workspacePath));
    this.open.set(botId, opened);
    return opened.view;
  }
  placement(botId: string): BotPlacement {
    const environments = this.store.environments, { home, current } = environments.placement(botId);
    const hostId = environments.host().id;
    return { home: home.kind, current: current.kind, computer: this.computers.status(botId), docker: this.computers.available,
      hostGranted: environments.grants(botId).some(grant => grant.id === hostId) };
  }
  /** The environments the Bot may be in: its sandbox, its default, and the ones its owner granted it. */
  usable(botId: string): EnvironmentRecord[] {
    const environments = this.store.environments;
    const all = [environments.computerOf(botId), environments.placement(botId).home, ...environments.grants(botId)];
    return [...new Map(all.filter((record): record is EnvironmentRecord => !!record).map(record => [record.id, record])).values()];
  }
  place(botId: string, record: EnvironmentRecord, workspacePath: string): Place {
    if (record.kind === "host") return { id: record.id, kind: "host", name: "your owner's computer", directory: workspacePath };
    return { id: record.id, kind: "sandbox", name: record.botId === botId ? "your sandbox" : "another Bot's sandbox", directory: COMPUTER_CWD };
  }
  /** A Bot's environments as other Bots see them in bots.list. */
  summary(botId: string) {
    const name = (record: EnvironmentRecord) => record.kind === "host" ? "owner's computer" : record.botId === botId ? "own sandbox" : "another Bot's sandbox";
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
      ...(record.id === home.id ? { default: true } : {}), ...(record.kind === "computer" ? { state: this.computers.status(record.botId ?? botId)?.state ?? "stopped" } : {}) })) };
  }
  /** environments.switch: the Bot moves itself, like cd, until it switches back. A sandbox is started first; if it
   * can't start, the Bot stays where it was. */
  async switch(botId: string, environmentId: string, workspacePath: string) {
    const target = this.usable(botId).find(record => record.id === environmentId);
    if (!target) throw new ChatError(404, "No work environment with this id that you may use; see environments.list");
    const already = this.store.environments.placement(botId).current.id === target.id;
    if (target.kind === "computer") await this.computers.ensure(target.botId ?? botId);
    this.store.environments.setCurrent(botId, target.id);
    return { ...this.place(botId, target, workspacePath), about: ABOUT[target.kind], ...(already ? { note: "You were already here." } : {}) };
  }
  /** The owner makes the Bot's sandbox (given it on first use) or their computer its default, and moves it there. */
  setHome(botId: string, kind: EnvironmentKind, workspacePath: string): Moved | null {
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
  /** The owner grants or takes back their computer (A50); taking it back while the Bot works there sends it home. */
  grantHost(botId: string, granted: boolean, by: string, workspacePath: string): { changed: boolean; moved: Moved | null } {
    const environments = this.store.environments, host = environments.host();
    if (granted) return { changed: environments.grant(host.id, botId, by), moved: null };
    const changed = environments.revoke(host.id, botId), { home, current } = environments.placement(botId);
    if (current.id !== host.id || home.id === host.id) return { changed, moved: null };
    const from = this.here(botId, workspacePath);
    environments.setCurrent(botId, home.id);
    return { changed, moved: { from, to: this.here(botId, workspacePath) } };
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
      id: env.id, kind: env.kind, cwd: env.cwd,
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
