import { createHash } from "node:crypto";
import { Member } from "../member.js";
import type { HistoryDraft } from "../../shared/history.js";
import type { ModelSelection } from "../../shared/runtime.js";
import type { Urgency } from "../../shared/delivery.js";
import type {
  BotParts, Identity, Model, Workspace, Tools, Memory, AgentRuntime,
  BotState, BotStatus, OutgoingMessage, SentMessage,
  SendSource, ChatDelivery, RuntimeSetup,
} from "./contracts.js";

/**
 * Bot 是完整的业务对象，持有七个组成对象并协调其公开接口。
 * 对外只有生命周期、收发、状态和模型变更；调度属于 AgentRuntime。
 */
export class Bot extends Member<OutgoingMessage, Promise<SentMessage>> {
  public readonly kind = "bot" as const;
  public readonly identity: Identity;
  public readonly model: Model;
  public readonly workspace: Workspace;
  public readonly tools: Tools;
  public readonly memory: Memory;
  public readonly agentRuntime: AgentRuntime;
  public readonly state: BotState;

  // 内部协作依赖，不是新增的 Bot 核心组成对象。
  private readonly chat: ChatDelivery;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly callHistory = new Map<string, number>();

  public constructor(id: string, parts: BotParts, chat: ChatDelivery) {
    super(id);
    this.identity = parts.identity;
    this.model = parts.model;
    this.workspace = parts.workspace;
    this.tools = parts.tools;
    this.memory = parts.memory;
    this.agentRuntime = parts.agentRuntime;
    this.state = parts.state;
    this.chat = chat;
  }

  /** 激活到 idle；不主动推理、不发送欢迎消息。 */
  public async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.status().status !== "stop") return;
    this.starting = this.activate();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async activate(): Promise<void> {
    await this.workspace.prepare();
    await this.memory.open();
    this.tools.bindSend((chatId, message) => this.send(chatId, message));
    await this.agentRuntime.start(this.runtimeSetup());
  }

  /** 停止运行并释放运行资源；Identity、Model、History 等持久数据保留。 */
  public async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.starting) await this.starting.catch(() => {});
      try { await this.agentRuntime.stop(); }
      finally { await this.memory.close(); this.callHistory.clear(); }
    })();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }

  /** 只中断当前执行，保留已激活的运行实例与会话。 */
  public async abort(): Promise<void> {
    await this.agentRuntime.abort();
  }

  /** 返回状态视图，不暴露可由调用者修改的内部状态。 */
  public status(): BotStatus {
    return this.state.snapshot();
  }

  /** 投递已保存（A41）；Bot 按需激活，交给运行层按急迫程度处理。附带的不必为它启动。 */
  public async deliver(urgency: Urgency): Promise<void> {
    if (urgency === "digest") return;
    if (this.stopping) await this.stopping;
    if (this.status().status === "stop") await this.start();
    this.agentRuntime.deliver(urgency);
  }

  /** 绑定真实发送者和发送来源，交由 Chat 的公开接口保存、投递。 */
  public async send(chatId: string, message: OutgoingMessage): Promise<SentMessage> {
    const source = this.sendSource(message);
    return this.chat.deliver({
      senderId: this.id,
      chatId,
      content: message.content,
      attachments: message.attachments,
      source, signal: message.signal, ...(message.question ? { question: message.question } : {}), ...(message.alsoToChannel ? { alsoToChannel: true } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      clientMessageId: source ? createHash("sha256").update(JSON.stringify([this.id, source.historyId, source.toolCallId])).digest("hex") : undefined,
    });
  }

  /** 由 Bot 协调配置与运行实例；配置在应用成功后提交。执行中切换从下一次模型请求生效（A28）。 */
  public async changeModel(selection: ModelSelection): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    await this.agentRuntime.reconfigure(async () => {
      const prepared = await this.model.prepare(selection);
      try {
        const applied = this.status().status === "stop" ? prepared : await this.agentRuntime.changeModel(prepared);
        await this.model.commit(applied);
      } catch (error) { this.model.failed(prepared, error); throw error; }
    });
  }

  private runtimeSetup(): RuntimeSetup {
    return {
      identity: () => this.identity.snapshot(),
      model: () => this.model.current(),
      workspace: this.workspace.location(),
      environment: () => this.workspace.environment(),
      tools: this.tools.definitions(),
      onStatus: status => this.updateState(status),
      onHistory: record => this.recordHistory(record),
    };
  }

  private updateState(status: BotStatus): void {
    this.state.update(status);
  }

  private async recordHistory(record: HistoryDraft): Promise<void> {
    const historyId = await this.memory.append(record);
    if (record.role !== "assistant") return;
    // 只记录当前模型消息里的调用；工具结果到达不会覆盖调用的来源。
    this.callHistory.clear();
    for (const block of record.message.content) {
      if (block.type === "tool_call") this.callHistory.set(block.tool_call_id, historyId);
    }
  }

  private sendSource(message: OutgoingMessage): SendSource | null {
    if (!message.toolCallId) return null;
    const historyId = this.callHistory.get(message.toolCallId);
    // A source exists only when this exact call was recorded; do not infer a parent call.
    return historyId === undefined ? null : { historyId, toolCallId: message.toolCallId };
  }
}

