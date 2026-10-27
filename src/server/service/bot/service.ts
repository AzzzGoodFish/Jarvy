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
import { BotEnvironments, type Moved } from "./environments.js";
import { Computers } from "./computers.js";
import type { HomeKind } from "../../shared/environment.js";
import { SshMachines } from "./machines.js";
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
import { botPromptParts } from "./prompt.js";
import { builtinSkills } from "../../infra/files/skills.js";
import type { Skill } from "../../shared/skill.js";
import type { RosterEntry } from "./roster.js";
import { LiveTurns } from "./live.js";
import { AgentOps } from "./agent.js";
import type { Deliveries } from "../delivery/delivery.js";
import { welcomeLanguage, type BotChange } from "../../shared/agent.js";
import type { LiveChat } from "../../shared/live.js";
import type { SecretService } from "../secrets.js";
import type { TaskService } from "../tasks.js";

export interface BotDependencies {
  store: Store; chats: ChatService; files: ChatFiles; credentials: CredentialCoordinator;
  /** The delivery module (A61): system notices to a Bot, such as a change to where it works. */
  deliveries: Deliveries;
  /** The owner's secrets (A52): each Bot's runs fill placeholders and mask values through it. */
  secrets: SecretService;
  /** Scheduled tasks (A58): each Bot manages its own with the tasks tools. */
  tasks: TaskService;
  changed: (botId: string) => void; factory?: SessionFactory;
  /** Bots were created, renamed or deleted by the agent Bot (A48): the owner's page reloads them. */
  listChanged?: () => void;
}
/** Service-level lifetime/lookup entry. Each Bot remains the complete business object. */
export class BotService {
  private readonly bots = new Map<string, Bot>();
  private readonly lives = new Map<string, LiveTurns>();
  private readonly computers: Computers;
  private readonly environments: BotEnvironments;
  /** The owner's SSH machines (A57). */
  readonly machines: SshMachines;
  private closed = false;
  private started = false;
  /** What only the agent Bot does (A48). */
  readonly agent: AgentOps;
  /** The skills that ship with Jarvy, for the agent Bot (A55). */
  private readonly skills: readonly Skill[] = builtinSkills();
  constructor(private readonly deps: BotDependencies) {
    this.agent = new AgentOps(this, deps.store, deps.chats, deps.deliveries);
    this.computers = new Computers({ store: deps.store, changed: () => this.listChanged() });
    this.machines = new SshMachines(deps.store, deps.chats, () => this.listChanged());
    this.environments = new BotEnvironments(deps.store, this.computers, this.machines);
  }
  listChanged() { this.deps.listChanged?.(); }
  get(id: string): Bot {
    if (this.closed) throw new RuntimeFault("stopping", "Shutting down.", 503);
    const record = this.deps.store.bots.get(id);
    if (!record) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    let bot = this.bots.get(id);
    if (bot) return bot;
    const { store, chats, files, credentials } = this.deps, live = this.live(id), skills = id === AGENT_BOT_ID ? this.skills : [];
    const here = () => { const place = this.environments.here(id, record.workspacePath); return { name: place.name, directory: place.directory }; };
    const runtime = new AgentRuntime(new BotInbox(id, store.runtime, chats, files, store.tasks, here), (setup, model, reference, activity) =>
      (this.deps.factory ?? PiSession.create)({ store, bot: record, selection: model.selection, reference, credentials,
        tools: setup.tools, systemPrompt: () => botPromptParts(setup, skills), onHistory: setup.onHistory, activity, live: event => live.event(event),
        environment: () => this.environments.current(id, record.workspacePath), secrets: this.deps.secrets.forBot(id) }));
    const workspace = new Workspace(record.workspacePath, () => this.environments.current(id, record.workspacePath), () => {
      const place = this.environments.home(id, record.workspacePath); return { kind: place.kind === "sandbox" ? "computer" as const : "host" as const, cwd: place.directory }; }, skills);
    const memory = new Memory(join(dirname(record.workspacePath), "history.db"));
    bot = new Bot(id, {
      identity: new Identity(id, store), model: new Model(id, store, resolveThinking),
      workspace, memory,
      tools: new Tools({ botId: id, chats, files, memory, workspace, asking: on => runtime.waitingForUser(on), roster: () => this.roster(),
        places: { list: () => this.environments.list(id, record.workspacePath), switch: environmentId => this.environments.switch(id, environmentId, record.workspacePath),
          summary: botId => this.environments.summary(botId), request: input => this.machines.prepareRequest(id, input), found: input => this.machines.find(id, input) },
        secrets: { list: () => this.deps.secrets.listFor(id), prepare: (name, purpose) => this.deps.secrets.prepareRequest(id, name, purpose) },
        tasks: this.deps.tasks,
        ...(id === AGENT_BOT_ID ? { agent: this.agent } : {}) }), agentRuntime: runtime,
      state: new BotState(() => this.deps.changed(id)),
    }, { deliver: async message => {
      const outgoing = await workspace.readOutgoing(message.attachments ?? [], message.signal);
      message.signal?.throwIfAborted();
      return chats.deliver(id, message.chatId, { content: message.content, attachmentIds: [], files: outgoing, source: message.source, clientMessageId: message.clientMessageId,
        ...(message.question ? { question: message.question } : {}), ...(message.alsoToChannel ? { alsoToChannel: true } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
    } });
    this.bots.set(id, bot);
    return bot;
  }
  private details(record: BotRecord) {
    const model = record.connectionId ? this.deps.store.connections.get(record.connectionId)?.models.find(model => model.id === record.modelId) : undefined;
    return { ...record, effectiveThinkingLevel: model ? resolveThinking(model, record.thinkingLevel) : null, agent: record.id === AGENT_BOT_ID,
      environment: this.environments.placement(record.id) };
  }
  owns(id: string) { return this.deps.store.bots.get(id) !== null; }
  /** The turn a Bot is running, live (A47); kept for a Bot whether or not it has started. */
  live(id: string): LiveTurns {
    if (!this.deps.store.bots.get(id)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
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
  list() { return this.deps.store.bots.list().map(record => this.details(record)); }
  /** A new Bot works in its sandbox when this machine has Docker, unless asked for the owner's computer (A50). */
  create(name: string, environment?: HomeKind) {
    const kind = environment ?? (this.computers.available ? "computer" : "host");
    if (kind === "computer" && !this.computers.available) throw new RuntimeFault("docker_unavailable", "Docker is not available on this machine.", 409);
    const record = this.deps.store.bots.create(name);
    this.environments.setHome(record.id, kind, record.workspacePath);
    return this.details(record);
  }
  /** The owner moves a Bot to its sandbox or to their computer, as its default; the next tool call runs there. */
  setHome(id: string, kind: HomeKind) {
    const moved = this.environments.setHome(id, kind, this.record(id).workspacePath);
    if (moved) this.tellOwner(id, [{ what: "environment", value: where(moved) }], true);
    return this.describe(id);
  }
  /** The owner lets a Bot use their computer, or takes it back; taking it back while the Bot is there sends it home. */
  grantHost(id: string, granted: boolean) { return this.grant(id, "host", granted); }
  /** The owner lets a Bot use an SSH machine (A57), or takes it back, the same way. */
  grantMachine(id: string, machineId: string, granted: boolean) { this.machines.get(machineId); return this.grant(id, machineId, granted); }
  /** The owner deletes an SSH machine: Bots working there are back in their default, and told. */
  async removeMachine(machineId: string, force: boolean): Promise<void> {
    const name = this.machines.get(machineId).name, granted = this.machines.get(machineId).botIds;
    const moved = await this.machines.remove(machineId, force);
    for (const id of new Set([...granted, ...moved])) {
      if (!this.deps.store.bots.get(id)) continue;
      const changes: BotChange[] = [{ what: "access", value: `${name}: removed` }];
      if (moved.includes(id)) { const to = this.environments.here(id, this.record(id).workspacePath); changes.push({ what: "environment", value: `${to.name}, in ${to.directory}` }); }
      this.tellOwner(id, changes, moved.includes(id));
    }
  }
  private grant(id: string, environmentId: string | "host", granted: boolean) {
    const { changed, moved, name } = this.environments.grant(id, environmentId, granted, this.deps.store.account.userMemberId(), this.record(id).workspacePath);
    const changes: BotChange[] = changed ? [{ what: "access", value: `${name}: ${granted ? "you may switch to it" : "taken back"}` }] : [];
    if (moved) changes.push({ what: "environment", value: where(moved) });
    if (changes.length) this.tellOwner(id, changes, !!moved);
    if (changed && environmentId !== "host") this.listChanged();
    return this.describe(id);
  }
  /** Tells a Bot what its owner changed about where it works (A41, A50), as system notices (A61). A move of a Bot that
   * is running interrupts its turn, as an @-mention does, so it doesn't go on in the old place; a Bot not running, or a
   * change of access alone, is told with its next batch. */
  private tellOwner(id: string, changes: readonly BotChange[], move: boolean) {
    // A Bot still being set up (no model yet, its first-setup card) has nothing to be told.
    if (!this.record(id).connectionId) return;
    const to = this.deps.chats.member(id);
    if (!to) return;
    const reason = move && this.bots.get(id)?.status().status === "running" ? "move" : "owner";
    this.deps.deliveries.notify({ to, kind: "change", reason, actorId: this.deps.store.account.userMemberId(), payloads: changes });
  }
  private record(id: string): BotRecord {
    const record = this.deps.store.bots.get(id);
    if (!record) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    return record;
  }
  /** Starting (or resetting, which starts afresh) returns at once: the Bot's state follows as it changes. */
  async computer(id: string, action: "start" | "stop" | "reset") {
    this.describe(id);
    if (action === "stop") await this.computers.stop(id);
    else {
      if (action === "reset") await this.computers.reset(id);
      void this.computers.ensure(id).catch(() => {});
    }
    return this.describe(id);
  }
  describe(id: string) { return this.details(this.record(id)); }
  runs(id: string) { this.describe(id); return this.deps.store.runtime.runs(id); }
  activity(id: string, before?: ActivityCursor, limit = 40) {
    const bot = this.get(id);
    const messages = this.deps.chats.sentActivity(this.deps.store.account.userMemberId(), id, before, limit + 1);
    return activityPage(messages, bot.memory.timeline(before, limit + 1), limit);
  }
  activityMessage(id: string, messageId: string) {
    this.describe(id);
    const actor = this.deps.store.account.userMemberId();
    const message = this.deps.chats.message(actor, messageId);
    if (!message || message.sender.id !== id) throw new RuntimeFault("message_missing", "Message not found", 404);
    const chat = this.deps.chats.get(actor, message.chatId)!;
    return { message, chat: { id: chat.id, title: chat.title } };
  }
  memory(id: string) { return this.get(id).memory; }
  /** A delivery reached a Bot (A41); the Bot responds to its urgency. */
  deliver(id: string, urgency: Urgency): void {
    if (this.closed || !this.deps.store.bots.get(id)) return;
    const bot = this.get(id);
    void bot.deliver(urgency).catch(error => {
      const fault = publicFault(error);
      bot.state.update({ ...bot.status(), error: { code: fault.code, message: fault.message, ...(fault.params ? { params: fault.params } : {}) } });
      console.error("[bot] delivery failed", { botId: id, code: fault.code });
    });
  }
  /** Picks up what is still waiting for a Bot (after a failure, a new model, or a restart), if anything. */
  resume(id: string): void {
    const waiting = this.deps.store.runtime.waitingBots(this.deps.store.account.userMemberId()).find(item => item.botId === id);
    if (waiting) this.deliver(id, waiting.urgency);
  }
  retry(id: string): void { this.resume(id); }
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.computers.start();
    for (const { botId, urgency } of this.deps.store.runtime.waitingBots(this.deps.store.account.userMemberId())) this.deliver(botId, urgency);
  }
  /** Every Bot's run state, for `bots.list` (A43). A Bot not loaded in this process is stopped. */
  roster(): RosterEntry[] {
    const { store } = this.deps;
    return store.bots.list().map(record => {
      const bot = this.bots.get(record.id), runId = bot?.agentRuntime.activeRunId ?? null;
      const status = bot?.status() ?? { status: "stop", activity: null, context: null, error: null };
      return { id: record.id, name: record.name, agent: record.id === AGENT_BOT_ID, status,
        runChatIds: status.status === "running" && runId ? store.runtime.inputs(runId).map(input => input.chatId) : [],
        errorCode: store.runtime.latestErrorCode(record.id) };
    });
  }
  status(id: string): BotStatus & { botId: string; runId: string | null } {
    if (!this.deps.store.bots.get(id)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    const bot = this.bots.get(id);
    return { ...(bot?.status() ?? { status: "stop", activity: null, context: null, error: null }), botId: id, runId: bot?.agentRuntime.activeRunId ?? null };
  }
  /** `language` is the browser's interface language: the agent Bot's first model asks it to welcome the owner in it (A48). */
  async selectModel(id: string, input: Record<string, unknown>) {
    const selection = this.deps.store.bots.validateSelection(id, input);
    if (!selection) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    await this.get(id).changeModel(selection);
    this.resume(id);
    if (id === AGENT_BOT_ID) this.agent.onboard(welcomeLanguage(input.language));
    return this.deps.store.bots.get(id)!;
  }
  connectionChanged(connectionId: string) {
    for (const bot of this.deps.store.bots.list()) if (bot.connectionId === connectionId) this.resume(bot.id);
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
    if (!this.deps.store.bots.delete(id)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
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

/** Where a move took the Bot, in the words it is told. */
const where = (moved: Moved) => `${moved.to.name}, in ${moved.to.directory}`;
