import { hostEnvironment } from "../../infra/env/host.js";
import type { Store } from "../../infra/storage/store.js";
import type { BotPlacement, EnvironmentKind, WorkEnvironment } from "../../shared/environment.js";
import type { Computers } from "./computers.js";

/** Where each Bot works (A50): its current environment, looked up at every tool call, so a move takes effect at the
 * next call without a new session. The owner's computer runs the tools in the Bot's workspace; a Bot's own computer
 * is a container (see Computers). An environment opens on first use and closes when the Bot moves, is deleted, or
 * Jarvy stops: an open connection would keep the process alive. */
export class BotEnvironments {
  private readonly open = new Map<string, { id: string; env: WorkEnvironment }>();
  constructor(private readonly store: Store, private readonly computers: Computers) {}

  current(botId: string, workspacePath: string): WorkEnvironment {
    const target = this.store.environments.placement(botId).current;
    const open = this.open.get(botId);
    if (open?.id === target.id) return open.env;
    if (open) void open.env.close();
    const env = target.kind === "computer" ? this.computers.environment(botId, target) : hostEnvironment(workspacePath);
    this.open.set(botId, { id: target.id, env });
    return env;
  }
  placement(botId: string): BotPlacement {
    const { home, current } = this.store.environments.placement(botId);
    return { home: home.kind, current: current.kind, computer: this.computers.status(botId), docker: this.computers.available };
  }
  /** Makes the Bot's own computer (given it on first use) or the owner's computer its default, and moves it there. */
  setHome(botId: string, kind: EnvironmentKind): void {
    const environments = this.store.environments;
    if (kind === "host") return environments.setHome(botId, environments.host().id);
    const computer = environments.computerOf(botId);
    if (computer) { environments.setHome(botId, computer.id); void this.computers.ensure(botId).catch(() => {}); }
    else this.computers.create(botId);
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
}
