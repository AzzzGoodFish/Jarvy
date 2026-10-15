import { AGENT_BOT_ID, type Bot as BotRecord } from "../../shared/models.js";
import { ChatError } from "../../shared/chat.js";
import type { BotChange, WelcomeLanguage } from "../../shared/agent.js";
import type { Store } from "../../infra/storage/store.js";
import { thinkingOptions } from "../../infra/pi/thinking.js";
import type { ChatService } from "../chat/service.js";
import type { BotService } from "./service.js";

/** The settings the agent Bot may give a Bot; only what is given changes. `model` names a connection (its id or name)
 * and a model in it (id or name), as `models.list` shows them. */
export interface BotSettings { name?: string; description?: string; persona?: string; model?: { connection: string; model: string }; thinking?: string }
const same = (a: string, b: string) => a.trim().replace(/^@/, "").toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** What only the agent Bot does (A48), behind its tools: Bots, their models and usage, and what is deleted once the
 * owner confirms. A Bot it changes is told with its next batch, in its DM with the agent. The first time the agent has
 * a model, it is asked to welcome the owner. */
export class AgentOps {
  constructor(private readonly bots: BotService, private readonly store: Store, private readonly chats: ChatService) {}
  get owner() { return this.store.userMemberId(); }
  readonly agentId = AGENT_BOT_ID;
  /** A Bot by name, ignoring case and a leading @. */
  bot(name: string): BotRecord {
    const bot = this.store.listBots().find(record => same(name, record.name));
    if (!bot) throw new ChatError(404, `No Bot named ${name} (see bots.list)`);
    return bot;
  }
  /** Connected models and their thinking levels; never credentials. */
  models() {
    return this.store.listModelConnections().filter(connection => connection.models.length).map(connection => ({
      connection: connection.displayName, connectionId: connection.id,
      models: connection.models.map(model => ({ id: model.id, name: model.name, thinking: ["auto", ...thinkingOptions(model).levels] })),
    }));
  }
  private selection(bot: BotRecord | null, input: BotSettings) {
    if (!input.model && input.thinking === undefined) return null;
    let connectionId = bot?.connectionId ?? null, modelId = bot?.modelId ?? "";
    if (input.model) {
      const { connection, model } = input.model;
      const found = this.store.listModelConnections().find(item => item.id === connection || same(connection, item.displayName));
      if (!found) throw new ChatError(404, `No connection named ${connection} (see models.list)`);
      const picked = found.models.find(item => item.id === model || same(model, item.name));
      if (!picked) throw new ChatError(404, `No model ${model} in ${found.displayName} (see models.list)`);
      connectionId = found.id; modelId = picked.id;
    }
    if (!connectionId) throw new ChatError(400, "This Bot has no model yet; give model too");
    return { connectionId, modelId, ...(input.thinking === undefined ? {} : { thinkingLevel: input.thinking }) };
  }
  /** Where a Bot works now: computer or host (A50). */
  environment(botId: string) { return this.bots.describe(botId).environment.home; }
  /** "model (connection)", as the agent and the changed Bot read it. */
  modelLabel(bot: BotRecord) {
    const connection = bot.connectionId ? this.store.getModelConnection(bot.connectionId) : null;
    const model = connection?.models.find(item => item.id === bot.modelId);
    return model ? `${model.name} (${connection!.displayName})` : bot.modelId;
  }
  async create(input: BotSettings & { name: string; environment?: "computer" | "host" }) {
    const selection = this.selection(null, input);
    const created = this.bots.create(input.name, input.environment);
    if (input.description !== undefined || input.persona !== undefined)
      this.bots.get(created.id).identity.update({ name: created.name, description: input.description ?? "", persona: input.persona ?? "" });
    if (selection) await this.bots.selectModel(created.id, selection);
    this.bots.listChanged();
    return this.store.getBot(created.id)!;
  }
  async update(bot: BotRecord, input: BotSettings) {
    const selection = this.selection(bot, input);
    if (input.name !== undefined || input.description !== undefined || input.persona !== undefined)
      this.bots.get(bot.id).identity.update({ name: input.name ?? bot.name, description: input.description ?? bot.description, persona: input.persona ?? bot.systemPrompt });
    if (selection) await this.bots.selectModel(bot.id, selection);
    const after = this.store.getBot(bot.id)!, changes: BotChange[] = [];
    if (after.name !== bot.name) changes.push({ what: "name", value: after.name });
    if (after.description !== bot.description) changes.push({ what: "description", value: after.description });
    if (after.systemPrompt !== bot.systemPrompt) changes.push({ what: "persona", value: null });
    if (after.connectionId !== bot.connectionId || after.modelId !== bot.modelId) changes.push({ what: "model", value: this.modelLabel(after) });
    if (after.thinkingLevel !== bot.thinkingLevel) changes.push({ what: "thinking", value: after.thinkingLevel });
    this.tell(bot.id, changes);
    this.bots.listChanged();
    return { bot: after, changed: changes.map(change => change.what) };
  }
  async run(bot: BotRecord, action: "start" | "stop") {
    if (action === "stop" && bot.id === AGENT_BOT_ID) throw new ChatError(400, "You can't stop yourself");
    const runtime = this.bots.get(bot.id);
    await (action === "start" ? runtime.start() : runtime.stop());
    this.tell(bot.id, [{ what: "run", value: action }]);
    return this.bots.status(bot.id).status;
  }
  usage(bot: BotRecord, days: number) {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    return { since: new Date(since).toISOString(), models: this.bots.memory(bot.id).usage(since) };
  }
  /** Deletions run as the owner, who has just confirmed them on a card. */
  async deleteBot(bot: BotRecord) {
    if (bot.id === AGENT_BOT_ID) throw new ChatError(400, "You can't delete yourself");
    await this.bots.delete(bot.id, true);
    this.bots.listChanged();
  }
  async deleteChannel(chatId: string) {
    if (!await this.chats.delete(this.owner, chatId)) throw new ChatError(404, "Channel not found");
    await this.bots.chatDeleted(chatId, AGENT_BOT_ID);
  }
  removeMember(chatId: string, memberId: string) { this.chats.channels.removeMember(this.owner, chatId, memberId); }
  deleteSection(sectionId: string) {
    if (!this.chats.channels.deleteSection(this.owner, sectionId)) throw new ChatError(404, "Section not found");
  }
  /** The changed Bot is told with its next batch (digest: it is not woken for it), in its DM with the agent. */
  private tell(botId: string, changes: readonly BotChange[]) {
    if (botId === AGENT_BOT_ID || !changes.length) return;
    const chatId = this.chats.openDirect(AGENT_BOT_ID, botId).id;
    for (const change of changes) this.store.agent.notify({ botId, kind: "change", reason: "agent", urgency: "digest", chatId, actorId: AGENT_BOT_ID, detail: JSON.stringify(change) });
  }
  /** The agent's first model: ask it, once, to welcome the owner in their DM, in their interface language. */
  onboard(language: WelcomeLanguage) {
    if (!this.store.agent.markOnboarded()) return;
    const chatId = this.chats.openDirect(this.owner, AGENT_BOT_ID).id;
    this.store.agent.notify({ botId: AGENT_BOT_ID, kind: "onboard", reason: "setup", urgency: "interrupt", chatId, actorId: this.owner, detail: language });
    this.bots.deliver(AGENT_BOT_ID, "interrupt");
  }
}
