import { hostEnvironment } from "../../infra/env/host.js";
import type { WorkEnvironment } from "../../shared/environment.js";

/** Each Bot's current work environment (A50). Every Bot works on the owner's computer, in its own workspace, until
 * Bots get computers of their own. An environment opens on first use and is closed when its Bot is gone or Jarvy
 * stops: an open connection would keep the process alive. */
export class BotEnvironments {
  private readonly open = new Map<string, WorkEnvironment>();

  current(botId: string, workspacePath: string): WorkEnvironment {
    let env = this.open.get(botId);
    if (!env) { env = hostEnvironment(workspacePath); this.open.set(botId, env); }
    return env;
  }
  async release(botId: string): Promise<void> {
    const env = this.open.get(botId);
    this.open.delete(botId);
    await env?.close();
  }
  async close(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map(env => env.close()));
  }
}
