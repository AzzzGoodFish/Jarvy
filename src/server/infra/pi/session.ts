import { PiHistoryAdapter } from "./history.js";
import type { HistoryDraft } from "../../shared/history.js";
import { resolveThinking } from "./thinking.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Store } from "../storage/store.js";
import type { Bot } from "../../shared/models.js";
import { RuntimeFault, type BotPhase, type ContextUsage, type ModelSelection, type SessionRef } from "../../shared/runtime.js";
import { CredentialCoordinator } from "../credentials/coordinator.js";
import { ConnectionCredentials, CurrentCredentials } from "./credentials.js";
import { installModel } from "./model.js";
import { configureHttp } from "./http.js";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "../../shared/tools.js";

export interface SessionOptions {
  store: Store; bot: Bot; selection: ModelSelection; reference: SessionRef;
  credentials: CredentialCoordinator; tools: readonly ToolDefinition[]; systemPrompt: () => string;
  onHistory?: (message: HistoryDraft) => void | Promise<void>;
  activity: (phase: BotPhase) => void;
}
/** The longest we wait for one provider request (Pi's default is five minutes). */
const HTTP_IDLE_TIMEOUT_MS = 900_000;
/** How one prompt ended, translated from Pi's events; `error` is Pi's own message for a failure. */
export type PromptResult = { outcome: "completed" | "interrupted" } | { outcome: "failed"; error: string };
export interface BotSession {
  readonly context?: ContextUsage;
  readonly thinkingLevel?: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  prompt(xml: string): Promise<PromptResult>;
  /** Queues a notice into the running turn (A39): delivered after the current tool batch, before the next
   * request. Only while a prompt is active; otherwise the caller keeps it for the next batch. */
  steer(xml: string): boolean;
  requestAbort(): void;
  configure(selection: ModelSelection): Promise<string>;
  dispose(): Promise<void>;
}
export type SessionFactory = (options: SessionOptions) => Promise<BotSession>;

/** All SDK event names, models and resources stay behind this adapter. */
export class PiSession implements BotSession {
  private session!: AgentSession;
  private unsubscribe?: () => void;
  private unsubscribeHistory?: () => void;
  private promptActive = false;
  private started = false;
  private settled = true;
  private settledResolve?: () => void;
  private wantsAbort = false;
  private abortTask?: Promise<void>;
  private abortFailure?: unknown;
  private result: PromptResult = { outcome: "completed" };
  private signature = "";
  private constructor(private readonly options: SessionOptions, private readonly models: ModelRuntime, private readonly credentials: CurrentCredentials) {}
  get context(): ContextUsage | undefined {
    const usage = this.session.getContextUsage();
    return usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined;
  }
  get thinkingLevel() { return this.session.thinkingLevel; }
  get sessionId() { return this.session.sessionId; }
  get sessionFile() { return this.session.sessionFile!; }

  static async create(options: SessionOptions): Promise<PiSession> {
    const { bot, store, reference, selection } = options;
    const agentDir = join(dirname(bot.workspacePath), "agent", "pi"), sessionsDir = join(agentDir, "sessions");
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    const expected = resolve(sessionsDir) + sep;
    if (!resolve(reference.file).startsWith(expected) || dirname(resolve(reference.file)) !== resolve(sessionsDir))
      throw new RuntimeFault("session_path", "会话文件路径无效。");
    const exists = existsSync(reference.file);
    if (!exists && (reference.persisted || store.runtime.runs(bot.id).some(run => run.state === "unknown")))
      throw new RuntimeFault("session_missing", "会话文件缺失，需检查运行记录后恢复。");
    if (exists) {
      let header: { type?: string; id?: string };
      try { header = JSON.parse(readFileSync(reference.file, "utf8").split("\n")[0]!); }
      catch { throw new RuntimeFault("session_corrupt", "会话文件无法读取。"); }
      if (header.type !== "session" || !header.id || (reference.sessionId && header.id !== reference.sessionId))
        throw new RuntimeFault("session_mismatch", "会话文件身份不匹配。");
    }
    const connection = store.getModelConnection(selection.connectionId);
    if (!connection) throw new RuntimeFault("connection_missing", "模型连接不存在。", 404);
    const scoped = new ConnectionCredentials(store.credentials, options.credentials, store.userMemberId(), connection.id, connection.providerName);
    await scoped.read(connection.providerName);
    const credentials = new CurrentCredentials(scoped);
    const models = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const configured = connection.models.find(model => model.id === selection.modelId);
    if (!configured) throw new RuntimeFault("model_missing", "模型不存在。", 404);
    const model = installModel(models, connection, configured, store.modelHeaders(connection.id, configured.id));
    const sessionManager = SessionManager.open(reference.file, sessionsDir, bot.workspacePath);
    const adapter = new PiSession(options, models, credentials);
    // The idle timeout is raised (A40) because a cold prefill of several hundred thousand tokens regularly
    // takes longer than Pi's 5-minute default (observed: a ~490k-token request timing out at 300s).
    // Compaction keeps Pi's defaults and follows the model's window.
    // The provider timeout comes from the settings; the HTTP client underneath needs the same limit.
    configureHttp(HTTP_IDLE_TIMEOUT_MS);
    const settingsManager = SettingsManager.inMemory({ httpIdleTimeoutMs: HTTP_IDLE_TIMEOUT_MS });
    const tools = ["bash", "read", "edit", "write", "codemode", ...options.tools.map(tool => tool.name)];
    const resourceLoader = new DefaultResourceLoader({ cwd: bot.workspacePath, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      systemPromptOverride: options.systemPrompt, appendSystemPromptOverride: () => [],
      extensionFactories: [createCodemodeExtension(), api => {
        for (const tool of options.tools) api.registerTool({
          name: tool.name, label: tool.name, description: tool.description,
          parameters: Type.Unsafe(tool.parameters as TSchema), executionMode: "sequential",
          execute: async (toolCallId, args, signal) => {
            const output = await tool.execute(args, { toolCallId, signal });
            return { content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }], details: {} };
          },
        });
        api.on("before_agent_start", () => ({ systemPrompt: options.systemPrompt() }));
      }],
    });
    await resourceLoader.reload();
    const result = await createAgentSession({ cwd: bot.workspacePath, agentDir, sessionManager, settingsManager, resourceLoader, modelRuntime: models, model,
      thinkingLevel: resolveThinking(model, selection.thinkingLevel), tools });
    adapter.session = result.session;
    if (result.extensionsResult.errors.length || !tools.every(name => adapter.session.getActiveToolNames().includes(name))) {
      adapter.session.dispose(); throw new RuntimeFault("tools_missing", "运行工具加载失败。");
    }
    adapter.unsubscribe = adapter.session.subscribe(event => adapter.onEvent(event));
    if (options.onHistory) {
      const history = new PiHistoryAdapter(sessionManager.getHeader()!);
      // Registered after AgentSession's own listener. Pi awaits listeners in order,
      // so message_end already has its final entry identity here (Pi 0.99.1).
      adapter.unsubscribeHistory = adapter.session.agent.subscribe(async event => {
        if (event.type !== "message_end") return;
        const entries = sessionManager.getEntries();
        for (let index = entries.length - 1; index >= 0; index--) {
          const entry = entries[index]!;
          if (entry.type !== "message" || entry.message !== event.message) continue;
          const record = history.convert(entry);
          if (record) await options.onHistory!(record);
          break;
        }
      });
    }
    store.runtime.recordSession(bot.id, adapter.sessionId, existsSync(adapter.sessionFile));
    adapter.signature = JSON.stringify([{ connectionId: selection.connectionId, modelId: selection.modelId }, connection.providerName, connection.api, connection.baseUrl, configured, store.modelHeaders(connection.id, configured.id)]);
    return adapter;
  }
  private onEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_start") { this.started = true; this.settled = false; this.options.activity("dispatching"); }
    if (event.type === "agent_settled") { this.settled = true; this.settledResolve?.(); }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") this.options.activity("texting");
      if (event.assistantMessageEvent.type === "thinking_delta") this.options.activity("thinking");
    }
    if (event.type === "turn_start") this.options.activity("dispatching");
    if (event.type === "auto_retry_start") this.options.activity("retrying");
    if (event.type === "tool_execution_start") this.options.activity("tool");
    if (event.type === "compaction_start") { this.options.activity("compacting"); console.log("[pi] compaction started", { botId: this.options.bot.id, reason: event.reason }); }
    if (event.type === "compaction_end") console.log(event.errorMessage ? "[pi] compaction failed" : "[pi] compaction finished",
      { botId: this.options.bot.id, reason: event.reason, aborted: event.aborted, tokensBefore: event.result?.tokensBefore,
        tokensAfter: event.result?.estimatedTokensAfter, error: event.errorMessage });
    if (event.type === "message_end" && event.message.role === "assistant") this.result = this.classify(event.message);
    this.maybeAbort();
  }
  /** The last assistant message decides the prompt (a later retry success replaces an earlier error).
   * pi-ai providers and Agent.handleRunFailure report a failure as "aborted" when the run's signal was
   * cancelled, but Pi 0.99.1's lazyStream reports request-setup failures as "error" regardless — e.g. the
   * request that follows a tool cancelled mid-run. Apply the same signal rule to those. */
  private classify(message: { stopReason: string; errorMessage?: string }): PromptResult {
    if (message.stopReason === "aborted" || (message.stopReason === "error" && this.session.agent.signal?.aborted)) return { outcome: "interrupted" };
    if (message.stopReason === "error") return { outcome: "failed", error: message.errorMessage?.trim() || "未知错误" };
    return { outcome: "completed" };
  }
  private maybeAbort(): void {
    if (!this.wantsAbort || !this.promptActive || this.abortTask || this.session.isIdle) return;
    this.options.activity("aborting");
    this.abortTask = this.session.abort().catch(error => { this.abortFailure = error; }).finally(() => { this.abortTask = undefined; });
  }
  /** A notice rides along with the running turn. Pi keeps queued steering messages across an abort, so a
   * notice steered just before a new message interrupts the turn is delivered at the start of the next one. */
  steer(xml: string): boolean {
    if (!this.promptActive || this.session.isIdle) return false;
    void this.session.steer(xml, undefined, { source: "extension" }).catch(error => {
      console.error("[pi] steer failed", { botId: this.options.bot.id, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  requestAbort(): void { this.wantsAbort = true; this.maybeAbort(); }
  async prompt(xml: string): Promise<PromptResult> {
    this.promptActive = true; this.started = false; this.settled = false; this.wantsAbort = false; this.abortFailure = undefined; this.result = { outcome: "completed" };
    const settled = new Promise<void>(resolve => { this.settledResolve = resolve; });
    try {
      await this.session.prompt(xml, { expandPromptTemplates: false });
    } finally {
      await this.session.waitForIdle();
      if (this.started && !this.settled) await settled;
      this.promptActive = false;
      await this.abortTask;
      this.options.store.runtime.recordSession(this.options.bot.id, this.sessionId, existsSync(this.sessionFile));
    }
    if (this.abortFailure) throw this.abortFailure;
    return this.result;
  }
  async configure(selection: ModelSelection): Promise<string> {
    const connection = this.options.store.getModelConnection(selection.connectionId), configured = connection?.models.find(item => item.id === selection.modelId);
    if (!connection || !configured) throw new RuntimeFault("model_missing", "模型不存在。", 404);
    const signature = JSON.stringify([{ connectionId: selection.connectionId, modelId: selection.modelId }, connection.providerName, connection.api, connection.baseUrl, configured, this.options.store.modelHeaders(connection.id, configured.id)]);
    if (signature === this.signature) {
      this.session.setThinkingLevel(resolveThinking(configured, selection.thinkingLevel), { persist: false });
      return this.session.thinkingLevel;
    }
    const next = new ConnectionCredentials(this.options.store.credentials, this.options.credentials, this.options.store.userMemberId(), connection.id, connection.providerName);
    await next.read(connection.providerName);
    const model = installModel(this.models, connection, configured, this.options.store.modelHeaders(connection.id, configured.id));
    // checkAuth inside setModel asks the credential store, so point it at the new connection first
    // and put the previous one back if the switch is rejected (the current turn may still run).
    const previous = this.credentials.current;
    this.credentials.current = next;
    try {
      await this.session.setModel(model, { persist: false });
      this.session.setThinkingLevel(resolveThinking(model, selection.thinkingLevel), { persist: false });
      this.signature = signature;
      return this.session.thinkingLevel;
    } catch {
      this.credentials.current = previous;
      throw new RuntimeFault("model_switch_uncertain", "模型切换未完成，请重新选择模型。", 409);
    }
  }
  async dispose(): Promise<void> {
    this.requestAbort();
    await this.abortTask;
    await this.session.waitForIdle();
    this.unsubscribeHistory?.(); this.unsubscribe?.(); this.session.dispose();
  }
}
