import type { Urgency } from "../../shared/delivery.js";
import type { ActivityCursor } from "../../shared/activity.js";
import type { ToolDefinition } from "../../shared/tools.js";
import type { HistoryDraft, HistoryPage, HistoryRecord, HistoryLink, HistoryReadMode, HistoryReadResult, HistorySummary } from "../../shared/history.js";
import type { ModelSelection } from "../../shared/runtime.js";
import type { QuestionSpec } from "../../shared/chat.js";

/** Bot 使用各组成对象的类型契约；组件实现独立展开，不在 Bot 内代实现。 */
export interface BotParts {
  identity: Identity;
  model: Model;
  workspace: Workspace;
  tools: Tools;
  memory: Memory;
  agentRuntime: AgentRuntime;
  state: BotState;
}

export interface Identity {
  snapshot(): { name: string; description: string; persona: string };
  update(input: { name: string; description: string; persona: string }): void;
  setColor(color: unknown): void;
}
export interface Model {
  current(): PreparedModel;
  prepare(selection: ModelSelection): Promise<PreparedModel>;
  commit(model: PreparedModel): Promise<void>;
  failed(model: PreparedModel, error: unknown): void;
}
export interface PreparedModel {
  selection: ModelSelection;
  credentialRef: string;
  changeId?: string;
}
export interface Workspace {
  prepare(): Promise<void>;
  location(): { type: string; cwd: string; tempDir: string };
  writeTempFile(name: string, content: string, signal?: AbortSignal): Promise<string>;
}
export interface Tools {
  bindSend(send: (chatId: string, message: OutgoingMessage) => Promise<SentMessage>): void;
  definitions(): readonly ToolDefinition[];
}
export interface Memory {
  open(): Promise<void>;
  append(record: HistoryDraft): number | Promise<number>;
  list(before?: number, limit?: number): HistoryPage;
  timeline(before: ActivityCursor | undefined, limit: number): HistorySummary[];
  read(id: number): { record: HistoryRecord; links: HistoryLink[] } | null;
  readMany(ids: readonly number[], mode: HistoryReadMode): HistoryReadResult;
  close(): void | Promise<void>;
}
export interface AgentRuntime {
  /** 负责实际运行和状态反馈。 */
  start(setup: RuntimeSetup): Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
  /** 有投递（A41）：打断 = 中止当前一轮再处理；排队 = 运行中 steer 进去、空闲时开始一轮；附带 = 等下一轮。 */
  deliver(urgency: Urgency): void;
  /** 与启动/停止及其他模型操作串行，但不等待当前执行轮结束。 */
  reconfigure(operation: () => Promise<void>): Promise<void>;
  changeModel(model: PreparedModel): Promise<PreparedModel>;
  readonly activeRunId: string | null;
}
export interface RuntimeSetup {
  identity: () => ReturnType<Identity["snapshot"]>;
  model: () => PreparedModel;
  workspace: ReturnType<Workspace["location"]>;
  tools: readonly ToolDefinition[];
  onStatus(status: BotStatus): void;
  onHistory(record: HistoryDraft): Promise<void>;
}
export interface BotState {
  snapshot(): BotStatus;
  update(status: BotStatus): void;
}
export interface BotStatus {
  status: "stop" | "idle" | "running";
  /** asking: a messages.ask call is waiting for the user (A36). */
  activity: "reasoning" | "texting" | "tool_calling" | "asking" | null;
  context: { tokens: number | null; limit: number } | null;
  error: { code: string; message: string } | null;
}
export interface OutgoingMessage {
  content: string;
  attachments?: readonly Attachment[];
  /** messages.ask: the message is a question card (A36). */
  question?: QuestionSpec;
  /** Thread replies: also post a copy to the channel (A37). */
  alsoToChannel?: boolean;
  /** The message this one replies to. */
  replyTo?: string;
  /** 由 Runtime/Tools 提供，不属于模型填写的工具参数。 */
  toolCallId?: string;
  signal?: AbortSignal;
}
export interface Attachment {
  name: string;
  path: string;
}
export interface SendSource {
  historyId: number;
  toolCallId: string;
}
export interface SentMessage {
  id: string;
  chatId: string;
  sequence: number;
  /** Members this message notified as mentioned (the @ in the text and a replied-to author). */
  mentions: readonly string[];
}
export interface ChatDelivery {
  deliver(message: {
    senderId: string;
    chatId: string;
    content: string;
    attachments?: readonly Attachment[];
    source: SendSource | null;
    clientMessageId?: string;
    signal?: AbortSignal;
    question?: QuestionSpec;
    alsoToChannel?: boolean;
    replyTo?: string;
  }): Promise<SentMessage>;
}
