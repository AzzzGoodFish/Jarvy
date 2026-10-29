import { PiHistoryAdapter } from "./history.js";
import type { HistoryDraft } from "../../shared/history.js";
import { resolveThinking } from "./thinking.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Store } from "../storage/store.js";
import type { Bot } from "../../shared/models.js";
import { reportedContext, type ContextEntry } from "./context.js";
import { PromptLog, type PromptChange } from "./prompt-change.js";
import type { PromptPart } from "../../shared/prompt.js";
import { RuntimeFault, type BotPhase, type ContextUsage, type ModelSelection, type SessionRef } from "../../shared/runtime.js";
import { CredentialCoordinator } from "../credentials/coordinator.js";
import { ConnectionCredentials, CurrentCredentials } from "./credentials.js";
import { installModel } from "./model.js";
import type { ModelCatalog } from "./catalog.js";
import { configureHttp } from "./http.js";
import { Type, type TSchema } from "typebox";
import { isToolMedia, type ToolDefinition } from "../../shared/tools.js";
import type { LiveEvent } from "../../shared/live.js";
import { LiveTranslator } from "./live.js";
import type { WorkEnvironment } from "../../shared/environment.js";
import { environmentTools } from "./environment-tools.js";
import type { SecretAccess } from "../../shared/secret.js";

export interface SessionOptions {
  store: Store; bot: Bot; selection: ModelSelection; reference: SessionRef;
  credentials: CredentialCoordinator; tools: readonly ToolDefinition[];
  /** The live system prompt in parts; the session goes on with the one it has and tells changes (A56). */
  systemPrompt: () => readonly PromptPart[];
  onHistory?: (message: HistoryDraft) => void | Promise<void>;
  activity: (phase: BotPhase) => void;
  /** The turn as it happens, step by step (A47). */
  live?: (event: LiveEvent) => void;
  /** A compaction rewrote the conversation (A67): whatever it held is gone, so what a Bot had read of its chat
   * notices is forgotten and told again where it acts. */
  onCompacted?: () => void;
  /** Where bash, read, write and edit run (A50): the Bot's current environment, asked at every tool call. */
  environment: () => WorkEnvironment;
  /** The Bot's secrets (A52): placeholders in bash, and masking of what reaches the model and the chat. */
  secrets?: SecretAccess;
  /** The model catalog (A49): a saved model takes what it leaves out, such as compat, from its entry (A62). */
  catalog?: ModelCatalog;
}
/** The longest we wait for one provider request (Pi's default is five minutes). */
const HTTP_IDLE_TIMEOUT_MS = 900_000;
/** How one prompt ended, translated from Pi's events; `error` is Pi's own message for a failure. */
export type PromptResult = { outcome: "completed" | "interrupted" } | { outcome: "failed"; error: string };

/** Room kept for compaction (A40): Pi's summary may use 80% of it, thinking included. Pi's 16k default left a model
 * thinking at a high level no room to finish the summary, every compaction failed and the context filled up (10/13).
 * Never below that default; up to a quarter of a small window, 13% of a large one, at most 64k. */
export function compactionReserve(contextWindow: number): number {
  return Math.min(65_536, Math.max(16_384, Math.min(32_768, Math.floor(contextWindow / 4)), Math.floor(contextWindow * 0.13)));
}

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
  /** How the live system prompt differs from the newest one the model knows (A56); null when it doesn't. */
  promptChange(): PromptChange | null;
  /** That change went to the model with a batch. */
  promptTold(change: PromptChange): void;
  dispose(): Promise<void>;
}
export type SessionFactory = (options: SessionOptions) => Promise<BotSession>;

/** All SDK event names, models and resources stay behind this adapter. */
export class PiSession implements BotSession {
  private session!: AgentSession;
  private settings!: SettingsManager;
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
  private readonly translator = new LiveTranslator();
  private prompts!: PromptLog;
  private constructor(private readonly options: SessionOptions, private readonly models: ModelRuntime, private readonly credentials: CurrentCredentials) {}
  get context(): ContextUsage | undefined {
    // Pi's own figure is used only for the window; the size is what the model reported (context.ts).
    const usage = this.session.getContextUsage();
    if (!usage) return undefined;
    const { tokens, stale } = reportedContext(this.session.sessionManager.getBranch() as readonly ContextEntry[]);
    return { tokens, contextWindow: usage.contextWindow, percent: tokens === null ? null : tokens / usage.contextWindow * 100, stale };
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
      throw new RuntimeFault("session_path", "The session file path isn't valid.");
    const exists = existsSync(reference.file);
    if (!exists && (reference.persisted || store.runtime.runs(bot.id).some(run => run.state === "unknown")))
      throw new RuntimeFault("session_missing", "The session file is missing; check the run records before recovering.");
    if (exists) {
      let header: { type?: string; id?: string };
      try { header = JSON.parse(readFileSync(reference.file, "utf8").split("\n")[0]!); }
      catch { throw new RuntimeFault("session_corrupt", "The session file can't be read."); }
      if (header.type !== "session" || !header.id || (reference.sessionId && header.id !== reference.sessionId))
        throw new RuntimeFault("session_mismatch", "The session file doesn't match this Bot.");
    }
    const connection = store.connections.get(selection.connectionId);
    if (!connection) throw new RuntimeFault("connection_missing", "Connection not found", 404);
    const scoped = new ConnectionCredentials(store.credentials, options.credentials, store.account.userMemberId(), connection.id, connection.providerName);
    await scoped.read(connection.providerName);
    const credentials = new CurrentCredentials(scoped);
    const models = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const configured = connection.models.find(model => model.id === selection.modelId);
    if (!configured) throw new RuntimeFault("model_missing", "Model not found", 404);
    await options.catalog?.ready();
    const model = installModel(models, connection, configured, store.connections.headers(connection.id, configured.id), options.catalog);
    const sessionManager = SessionManager.open(reference.file, sessionsDir, bot.workspacePath);
    const adapter = new PiSession(options, models, credentials);
    adapter.prompts = new PromptLog(options.systemPrompt);
    // The idle timeout is raised (A40) because a cold prefill of several hundred thousand tokens regularly
    // takes longer than Pi's 5-minute default (observed: a ~490k-token request timing out at 300s).
    // Compaction follows the model's window, with more room for its summary than Pi's default (compactionReserve).
    // The provider timeout comes from the settings; the HTTP client underneath needs the same limit.
    configureHttp(HTTP_IDLE_TIMEOUT_MS);
    const settingsManager = SettingsManager.inMemory({ httpIdleTimeoutMs: HTTP_IDLE_TIMEOUT_MS,
      compaction: { reserveTokens: compactionReserve(model.contextWindow) } });
    const tools = ["bash", "read", "edit", "write", "codemode", ...options.tools.map(tool => tool.name)];
    const resourceLoader = new DefaultResourceLoader({ cwd: bot.workspacePath, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      systemPromptOverride: () => adapter.prompts.current, appendSystemPromptOverride: () => [],
      extensionFactories: [createCodemodeExtension(), api => {
        for (const tool of options.tools) api.registerTool({
          name: tool.name, label: tool.name, description: tool.description,
          parameters: Type.Unsafe(tool.parameters as TSchema), executionMode: "sequential",
          execute: async (toolCallId, args, signal) => {
            // What a Bot writes into Jarvy (messages, notices, titles) never carries a secret's value.
            const output = await tool.execute(options.secrets ? options.secrets.masker().maskDeep(args) : args, { toolCallId, signal });
            if (isToolMedia(output)) return { content: [{ type: "text", text: output.text },
              ...output.images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))], details: {} };
            return { content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }], details: {} };
          },
        });
        // The prompt the session has, not the live one: a change is told in the batch, so the cache stays (A56).
        api.on("before_agent_start", () => ({ systemPrompt: adapter.prompts.current }));
        // Every tool result, nested codemode calls included, is masked before Pi keeps it or the model sees it.
        api.on("tool_result", event => {
          const masker = options.secrets?.masker();
          if (!masker || masker.empty) return undefined;
          let changed = false;
          const content = event.content.map(part => {
            if (part.type !== "text") return part;
            const text = masker.mask(part.text);
            if (text === part.text) return part;
            changed = true; return { ...part, text };
          });
          if (!changed) return undefined;
          return { content, ...(event.structuredContent !== undefined ? { structuredContent: masker.maskDeep(event.structuredContent) } : {}) };
        });
      }],
    });
    await resourceLoader.reload();
    const result = await createAgentSession({ cwd: bot.workspacePath, agentDir, sessionManager, settingsManager, resourceLoader, modelRuntime: models, model,
      thinkingLevel: resolveThinking(model, selection.thinkingLevel), tools, customTools: environmentTools(options.environment, options.secrets) });
    adapter.session = result.session; adapter.settings = settingsManager;
    if (result.extensionsResult.errors.length || !tools.every(name => adapter.session.getActiveToolNames().includes(name))) {
      adapter.session.dispose(); throw new RuntimeFault("tools_missing", "Couldn't load the run's tools.");
    }
    adapter.unsubscribe = adapter.session.subscribe(event => adapter.onEvent(event));
    if (options.onHistory) {
      const history = new PiHistoryAdapter(sessionManager.getHeader()!);
      // Registered after AgentSession's own listener. Pi awaits listeners in order,
      // so message_end already has its final entry identity here (Pi 1.2.0).
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
    adapter.signature = JSON.stringify([{ connectionId: selection.connectionId, modelId: selection.modelId }, connection.providerName, connection.api, connection.baseUrl, configured, store.connections.headers(connection.id, configured.id)]);
    return adapter;
  }
  /** A batch never carries a secret's value, even one a person pasted into the chat. */
  private masked(xml: string): string { return this.options.secrets?.masker().mask(xml) ?? xml; }
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
    // A compaction rewrote the conversation, so nothing cached is left to keep: take up the live prompt (A56).
    if (event.type === "compaction_end" && event.result && !event.aborted && !event.errorMessage) {
      this.prompts.take(this.options.systemPrompt);
      // What a notice said is out of the conversation too; a Bot has to read it again (A67).
      this.options.onCompacted?.();
    }
    if (event.type === "compaction_end") console.log(event.errorMessage ? "[pi] compaction failed" : "[pi] compaction finished",
      { botId: this.options.bot.id, reason: event.reason, aborted: event.aborted, tokensBefore: event.result?.tokensBefore,
        tokensAfter: event.result?.estimatedTokensAfter, error: event.errorMessage });
    if (event.type === "message_end" && event.message.role === "assistant") this.result = this.classify(event.message);
    if (this.options.live) for (const live of this.translator.translate(event))
      this.options.live(live.type === "tool_end" && this.options.secrets ? { ...live, output: this.options.secrets.masker().mask(live.output) } : live);
    this.maybeAbort();
  }
  /** The last assistant message decides the prompt (a later retry success replaces an earlier error).
   * pi-ai providers and Agent.handleRunFailure report a failure as "aborted" when the run's signal was
   * cancelled, but Pi 1.2.0's lazyStream reports request-setup failures as "error" regardless — e.g. the
   * request that follows a tool cancelled mid-run. Apply the same signal rule to those. */
  private classify(message: { stopReason: string; errorMessage?: string }): PromptResult {
    if (message.stopReason === "aborted" || (message.stopReason === "error" && this.session.agent.signal?.aborted)) return { outcome: "interrupted" };
    if (message.stopReason === "error") return { outcome: "failed", error: message.errorMessage?.trim() || "Unknown error" };
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
    void this.session.steer(this.masked(xml), undefined, { source: "extension" }).catch(error => {
      console.error("[pi] steer failed", { botId: this.options.bot.id, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  requestAbort(): void { this.wantsAbort = true; this.maybeAbort(); }
  async prompt(xml: string): Promise<PromptResult> {
    this.promptActive = true; this.started = false; this.settled = false; this.wantsAbort = false; this.abortFailure = undefined; this.result = { outcome: "completed" };
    const settled = new Promise<void>(resolve => { this.settledResolve = resolve; });
    this.options.live?.({ type: "start" });
    let outcome: PromptResult["outcome"] = "failed";
    try {
      try {
        await this.session.prompt(this.masked(xml), { expandPromptTemplates: false });
      } finally {
        await this.session.waitForIdle();
        if (this.started && !this.settled) await settled;
        this.promptActive = false;
        await this.abortTask;
        this.options.store.runtime.recordSession(this.options.bot.id, this.sessionId, existsSync(this.sessionFile));
      }
      if (this.abortFailure) throw this.abortFailure;
      outcome = this.result.outcome;
      return this.result;
    } finally { this.options.live?.({ type: "end", outcome }); }
  }
  async configure(selection: ModelSelection): Promise<string> {
    const connection = this.options.store.connections.get(selection.connectionId), configured = connection?.models.find(item => item.id === selection.modelId);
    if (!connection || !configured) throw new RuntimeFault("model_missing", "Model not found", 404);
    const signature = JSON.stringify([{ connectionId: selection.connectionId, modelId: selection.modelId }, connection.providerName, connection.api, connection.baseUrl, configured, this.options.store.connections.headers(connection.id, configured.id)]);
    if (signature === this.signature) {
      this.session.setThinkingLevel(resolveThinking(configured, selection.thinkingLevel), { persist: false });
      return this.session.thinkingLevel;
    }
    const next = new ConnectionCredentials(this.options.store.credentials, this.options.credentials, this.options.store.account.userMemberId(), connection.id, connection.providerName);
    await next.read(connection.providerName);
    const model = installModel(this.models, connection, configured, this.options.store.connections.headers(connection.id, configured.id), this.options.catalog);
    // checkAuth inside setModel asks the credential store, so point it at the new connection first
    // and put the previous one back if the switch is rejected (the current turn may still run).
    const previous = this.credentials.current;
    this.credentials.current = next;
    try {
      await this.session.setModel(model, { persist: false });
      this.settings.applyOverrides({ compaction: { reserveTokens: compactionReserve(model.contextWindow) } });
      this.session.setThinkingLevel(resolveThinking(model, selection.thinkingLevel), { persist: false });
      this.signature = signature;
      // Another model caches nothing of this one's: its first request goes with the live prompt (A56).
      this.prompts.take(this.options.systemPrompt);
      return this.session.thinkingLevel;
    } catch {
      this.credentials.current = previous;
      throw new RuntimeFault("model_switch_uncertain", "The model switch didn't finish. Pick the model again.", 409);
    }
  }
  promptChange(): PromptChange | null { return this.prompts.pending(this.options.systemPrompt); }
  promptTold(change: PromptChange): void { this.prompts.sent(change); }
  async dispose(): Promise<void> {
    this.requestAbort();
    await this.abortTask;
    await this.session.waitForIdle();
    this.unsubscribeHistory?.(); this.unsubscribe?.(); this.session.dispose();
  }
}
