import type { Store } from "../../infra/storage/store.js";
import type { Identity as IdentityPort } from "./contracts.js";
import { AGENT_BOT_ID } from "../../shared/models.js";

export class Identity implements IdentityPort {
  constructor(private readonly botId: string, private readonly store: Store) {}
  update(input: { name: string; description: string; persona: string }) {
    this.store.updateBot(this.botId, { name: input.name, description: input.description, systemPrompt: input.persona });
  }
  setColor(color: unknown) { this.store.setBotColor(this.botId, color); }
  snapshot() { const bot = this.store.getBot(this.botId)!; return { name: bot.name, description: bot.description, persona: bot.systemPrompt, agent: this.botId === AGENT_BOT_ID }; }
}
