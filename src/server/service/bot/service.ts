import type { Urgency } from "../../shared/delivery.js";
import type { ActivityCursor } from "../../shared/activity.js";
import { activityPage } from "./activity.js";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import type { Store } from "../../infra/storage/store.js";
import { AGENT_BOT_ID, type Bot as BotRecord } from "../../shared/models.js";
import type { BotStatus } from "./contracts.js";
import { RuntimeFault, publicFault } from "../../shared/runtime.js";
import type { ChatService } from "../chat/service.js";
import type { ChatFiles } from "../chat/files.js";
import type { CredentialCoordinator } from "../../infra/credentials/coordinator.js";
import { PiSession, type SessionFactory } from "../../infra/pi/session.js";
import { BotEnvironments } from "./environments.js";
import { resolveThinking } from "../../infra/pi/thinking.js";
import { Memory } from "./memory.js";
import { Bot } from "./bot.js";
import { Identity } from "./identity.js";
import { Model } from "./model.js";
import { Workspace } from "./workspace.js";
import { BotState } from "./state.js";
import { Tools } from "./tools.js";
import { AgentRuntime } from "./agent-runtime.js";
import { BotInbox } from "./inbox.js";
import { botPrompt } from "./prompt.js";
import type { RosterEntry } from "./roster.js";
import { LiveTurns } from "./live.js";
import { AgentOps } from "./agent.js";
import { welcomeLanguage } from "../../shared/agent.js";
import type { LiveChat } from "../../shared/live.js";

export interface BotDependencies {
  store: Store; chats: ChatService; files: ChatFiles; credentials: CredentialCoordinator;
  changed: (botId: string) => void; factory?: SessionFactory;
  /** Bots were created, renamed or deleted by the agent Bot (A48): the owner's page reloads them. */
  listChanged?: () => void;
}
/** Service-level lifetime/lookup entry. Each Bot remains the complete business object. */
export class BotService {
  private readonly bots = new Map<string, Bot>();
  private readonly lives = new Map<string, LiveTurns>();
  private readonly environments = new BotEnvironments();
  private closed = false;
  private started = false;
  /** What only the agent Bot does (A48). */
  readonly agent: AgentOps;
  constructor(private readonly deps: BotDependencies) { this.agent = new AgentOps(this, deps.store, deps.chats); }
  listChanged() { this.deps.listChanged?.(); }
  get(id: string): Bot {
    if (this.closed) throw new RuntimeFault("stopping", "Shutting down.", 503);
    const record = this.deps.store.getBot(id);
    if (!record) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    let bot = this.bots.get(id);
    if (bot) return bot;
    const { store, chats, files, credentials } = this.deps, live = this.live(id);
    const runtime = new AgentRuntime(new BotInbox(id, store.runtime, chats, files), (setup, model, reference, activity) =>
      (this.deps.factory ?? PiSession.create)({ store, bot: record, selection: model.selection, reference, credentials,
        tools: setup.tools, systemPrompt: () => botPrompt(setup), onHistory: setup.onHistory, activity, live: event => live.event(event),
        environment: () => this.environments.current(id, record.workspacePath) }));
    const workspace = new Workspace(record.workspacePath);
    const memory = new Memory(join(dirname(record.workspacePath), "history.db"));
    bot = new Bot(id, {
      identity: new Identity(id, store), model: new Model(id, store, resolveThinking),
      workspace, memory,
      tools: new Tools({ botId: id, chats, files, memory, workspace, asking: on => runtime.waitingForUser(on), roster: () => this.roster(),
        ...(id === AGENT_BOT_ID ? { agent: this.agent } : {}) }), agentRuntime: runtime,
      state: new BotState(() => this.deps.changed(id)),
    }, { deliver: async message => {
      const outgoing = await files.readOutgoing(record.workspacePath, message.attachments ?? [], message.signal);
      message.signal?.throwIfAborted();
      return chats.deliver(id, message.chatId, { content: message.content, attachmentIds: [], files: outgoing, source: message.source, clientMessageId: message.clientMessageId,
        ...(message.question ? { question: message.question } : {}), ...(message.alsoToChannel ? { alsoToChannel: true } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
    } });
    this.bots.set(id, bot);
    return bot;
  }
  private details(record: BotRecord) {
    const model = record.connectionId ? this.deps.store.getModelConnection(record.connectionId)?.models.find(model => model.id === record.modelId) : undefined;
    return { ...record, effectiveThinkingLevel: model ? resolveThinking(model, record.thinkingLevel) : null, agent: record.id === AGENT_BOT_ID };
  }
  owns(id: string) { return this.deps.store.getBot(id) !== null; }
  /** The turn a Bot is running, live (A47); kept for a Bot whether or not it has started. */
  live(id: string): LiveTurns {
    if (!this.deps.store.getBot(id)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    let live = this.lives.get(id);
    if (!live) { live = new LiveTurns(chatId => this.liveChat(id, chatId)); this.lives.set(id, live); }
    return live;
  }
  /** A chat as the Bot sees it, for the live turn: a DM is named after the other member. */
  private liveChat(botId: string, chatId: string): LiveChat | null {
    const chat = this.deps.chats.get(botId, chatId);
    if (!chat) return null;
    const other = chat.type === "dm" ? chat.memberIds.find(member => member !== botId) : undefined;
    return { id: chat.id, type: chat.type, title: other ? this.deps.chats.member(other)?.name ?? chat.title : chat.title };
  }
  list() { return this.deps.store.listBots().map(record => this.details(record)); }
  create(name: string) { return this.details(this.deps.store.createBot(name)); }
  describe(id: string) {
    const record = this.deps.store.getBot(id);
    if (!record) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    return this.details(record);
  }
  runs(id: string) { this.describe(id); return this.deps.store.runtime.runs(id); }
  activity(id: string, before?: ActivityCursor, limit = 40) {
    const bot = this.get(id);
    const messages = this.deps.chats.sentActivity(this.deps.store.userMemberId(), id, before, limit + 1);
    return activityPage(messages, bot.memory.timeline(before, limit + 1), limit);
  }
  activityMessage(id: string, messageId: string) {
    this.describe(id);
    const actor = this.deps.store.userMemberId();
    const message = this.deps.chats.message(actor, messageId);
    if (!message || message.sender.id !== id) throw new RuntimeFault("message_missing", "Message not found", 404);
    const chat = this.deps.chats.get(actor, message.chatId)!;
    return { message, chat: { id: chat.id, title: chat.title } };
  }
  memory(id: string) { return this.get(id).memory; }
  /** A delivery reached a Bot (A41); the Bot responds to its urgency. */
  deliver(id: string, urgency: Urgency): void {
    if (this.closed || !this.deps.store.getBot(id)) return;
    const bot = this.get(id);
    void bot.deliver(urgency).catch(error => {
      const fault = publicFault(error);
      bot.state.update({ ...bot.status(), error: { code: fault.code, message: fault.message, ...(fault.params ? { params: fault.params } : {}) } });
      console.error("[bot] delivery failed", { botId: id, code: fault.code });
    });
  }
  /** Picks up what is still waiting for a Bot (after a failure, a new model, or a restart), if anything. */
  resume(id: string): void {
    const waiting = this.deps.store.runtime.waitingBots(this.deps.store.userMemberId()).find(item => item.botId === id);
    if (waiting) this.deliver(id, waiting.urgency);
  }
  retry(id: string): void { this.resume(id); }
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const { botId, urgency } of this.deps.store.runtime.waitingBots(this.deps.store.userMemberId())) this.deliver(botId, urgency);
  }
  /** Every Bot's run state, for `bots.list` (A43). A Bot not loaded in this process is stopped. */
  roster(): RosterEntry[] {
    const { store } = this.deps;
    return store.listBots().map(record => {
      const bot = this.bots.get(record.id), runId = bot?.agentRuntime.activeRunId ?? null;
      const status = bot?.status() ?? { status: "stop", activity: null, context: null, error: null };
      return { id: record.id, name: record.name, agent: record.id === AGENT_BOT_ID, status,
        runChatIds: status.status === "running" && runId ? store.runtime.inputs(runId).map(input => input.chatId) : [],
        errorCode: store.runtime.latestErrorCode(record.id) };
    });
  }
  status(id: string): BotStatus & { botId: string; runId: string | null } {
    if (!this.deps.store.getBot(id)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    const bot = this.bots.get(id);
    return { ...(bot?.status() ?? { status: "stop", activity: null, context: null, error: null }), botId: id, runId: bot?.agentRuntime.activeRunId ?? null };
  }
  /** `language` is the browser's interface language: the agent Bot's first model asks it to welcome the owner in it (A48). */
  async selectModel(id: string, input: Record<string, unknown>) {
    const selection = this.deps.store.validateSelection(id, input);
    if (!selection) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    await this.get(id).changeModel(selection);
    this.resume(id);
    if (id === AGENT_BOT_ID) this.agent.onboard(welcomeLanguage(input.language));
    return this.deps.store.getBot(id)!;
  }
  connectionChanged(connectionId: string) {
    for (const bot of this.deps.store.listBots()) if (bot.connectionId === connectionId) this.resume(bot.id);
  }
  /** A deleted chat ends the turns handling it; `except` is the agent Bot that deleted it from inside its turn. */
  async chatDeleted(chatId: string, except?: string): Promise<void> {
    for (const [id, bot] of this.bots) {
      if (id === except) continue;
      const runId = bot.agentRuntime.activeRunId;
      if (runId && this.deps.store.runtime.inputs(runId).some(input => input.chatId === chatId)) await bot.abort();
    }
  }
  /** Deletes a Bot: stop it, drop its data, keep its messages. `keepFiles` leaves the workspace (and
   * the History database) on disk, since it may hold work worth keeping. */
  async delete(id: string, keepFiles: boolean): Promise<void> {
    if (id === AGENT_BOT_ID) throw new RuntimeFault("agent_undeletable", "The agent Bot can't be deleted", 409);
    const bot = this.get(id), workspacePath = bot.workspace.location().cwd;
    await bot.stop();
    this.bots.delete(id);
    this.lives.get(id)?.close(); this.lives.delete(id);
    await this.environments.release(id);
    if (!this.deps.store.deleteBot(id)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    if (!keepFiles) await rm(dirname(workspacePath), { recursive: true, force: true });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.bots.values()].map(bot => bot.stop()));
    for (const live of this.lives.values()) live.close();
    await this.environments.close();
  }
}
