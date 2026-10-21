import { RuntimeFault, publicFault, type BotPhase, type SessionRef } from "../../shared/runtime.js";
import type { BotSession, PromptResult } from "../../infra/pi/session.js";
import type { AgentRuntime as RuntimePort, RuntimeSetup, PreparedModel, BotStatus } from "./contracts.js";
import type { Urgency } from "../../shared/delivery.js";
import { BotInbox } from "./inbox.js";

export type CreateSession = (setup: RuntimeSetup, model: PreparedModel, reference: SessionRef, activity: (phase: BotPhase) => void) => Promise<BotSession>;

/** Execution component: one SDK session and one input pump, not an Actor. */
export class AgentRuntime implements RuntimePort {
  private session?: BotSession;
  private setup?: RuntimeSetup;
  private model?: PreparedModel;
  private pump?: Promise<void>;
  private operations: Promise<unknown> = Promise.resolve();
  private configuring: Promise<unknown> = Promise.resolve();
  private pauses = 0;
  private stopping = false;
  private inputVersion = 0;
  private wakeVersion = 0;
  private prompting = false;
  private promptTask?: Promise<PromptResult>;
  private notices: Promise<unknown> = Promise.resolve();
  private runId: string | null = null;
  private status: BotStatus = { status: "stop", activity: null, context: null, error: null };
  constructor(private readonly inbox: BotInbox, private readonly createSession: CreateSession) {}
  get activeRunId() { return this.runId; }
  private update(patch: Partial<BotStatus>) {
    const context = this.session?.context;
    this.status = { ...this.status, ...patch, context: context ? { tokens: context.tokens, limit: context.contextWindow, stale: context.stale } : null };
    this.setup?.onStatus(this.status);
  }
  private activity(phase: BotPhase) {
    this.update({ status: "running", activity: phase === "thinking" ? "reasoning" : phase === "texting" ? "texting" : phase === "tool" ? "tool_calling" : null });
  }
  /** A messages.ask call started or stopped waiting for the user (A36). */
  waitingForUser(on: boolean) {
    if (this.prompting) this.update({ status: "running", activity: on ? "asking" : "tool_calling" });
  }
  private fail(error: unknown) {
    const fault = publicFault(error);
    this.update({ status: this.session ? "idle" : "stop", activity: null, error: { code: fault.code, message: fault.message, ...(fault.params ? { params: fault.params } : {}) } });
    // An unexpected error has no public code of its own; log what it was so the run can be diagnosed.
    console.error("[bot] execution failed", { botId: this.inbox.botId, runId: this.runId, code: fault.code, ...(error instanceof RuntimeFault ? {} : { error }) });
  }
  async start(setup: RuntimeSetup): Promise<void> {
    await this.operation(async () => {
      this.stopping = false; this.setup = setup;
      try { this.model = setup.model(); await this.ensureSession(); this.update({ status: "idle", activity: null, error: null }); }
      catch (error) { this.fail(error); throw error; }
    });
  }
  private async ensureSession(): Promise<BotSession> {
    const reference = this.inbox.reference(this.setup!.workspace.cwd);
    if (this.session) {
      // Reads this.model inside the lock so a concurrent change is never reverted by a stale selection.
      try { await this.exclusive(() => this.session!.configure(this.model!.selection)); return this.session; }
      catch (error) { await this.session.dispose(); this.session = undefined; throw error; }
    }
    this.session = await this.createSession(this.setup!, this.model!, reference, phase => this.activity(phase));
    return this.session;
  }
  /** Something was delivered (A41); the runtime only looks at how urgent it is. Interrupt: abort the running
   * turn and start over with everything pending (A05). Queue: steer it into the running turn, or wake an idle
   * Bot (A39). Digest: nothing now, it rides along with the next run. The delivery itself is durable. */
  deliver(urgency: Urgency): void {
    if (this.stopping || urgency === "digest") return;
    if (urgency === "interrupt") {
      this.inputVersion++;
      if (this.prompting) this.session?.requestAbort();
      this.wake();
      return;
    }
    if (!this.prompting) { this.wake(); return; }
    // Serialised so two quick deliveries cannot both read the same pending rows.
    this.notices = this.notices.catch(() => {}).then(async () => {
      const pending = this.inbox.notices();
      if (!pending || this.stopping) return;
      if (this.prompting && this.session?.steer(pending.xml)) this.inbox.tell(pending.ids);
      else this.wake();
    }).catch(error => { console.error("[bot] steer failed", { botId: this.inbox.botId, error }); });
  }
  private wake() { if (!this.stopping) { this.wakeVersion++; this.schedule(); } }
  private schedule() {
    if (!this.setup || !this.session || this.pump || this.stopping || this.pauses || !this.inbox.pending()) return;
    const wake = this.wakeVersion;
    this.pump = Promise.resolve().then(() => this.drain()).catch(error => this.fail(error)).finally(() => {
      this.pump = undefined;
      if (this.wakeVersion > wake) this.schedule();
    });
  }
  private async drain() {
    const repository = this.inbox.repository;
    while (!this.stopping && !this.pauses && this.inbox.pending()) {
      const session = await this.ensureSession();
      if (this.stopping || this.pauses) break;
      const selection = this.model!.selection;
      const batch = this.inbox.claim({ ...selection, thinkingLevel: session.thinkingLevel ?? selection.thinkingLevel });
      if (!batch) break;
      const version = this.inputVersion;
      this.runId = batch.run.id;
      this.update({ error: null });
      let submitted = false;
      try {
        // A changed system prompt is told with the batch, not swapped in (A56).
        const change = session.promptChange();
        const prepared = await this.inbox.prepare(batch, change);
        if (!prepared) { repository.releaseUnsubmitted(batch.run.id); continue; }
        const { xml, notices } = prepared;
        if (this.stopping || this.pauses || version !== this.inputVersion) { repository.releaseUnsubmitted(batch.run.id); continue; }
        repository.submitted(batch.run.id); submitted = true; this.prompting = true;
        this.inbox.acknowledge(notices);
        if (change) session.promptTold(change);
        this.promptTask = session.prompt(xml);
        const result = await this.promptTask;
        repository.finish(batch.run.id, result.outcome, result.outcome === "failed" ? "model_request_failed" : null);
        // Show the provider's reason (e.g. a 400 body) instead of a generic hint; one line, bounded.
        if (result.outcome === "failed") { const detail = result.error.replace(/\s+/g, " ").slice(0, 300); throw new RuntimeFault("model_request_failed", `Model request failed: ${detail}`, 502, { detail }); }
      } catch (error) {
        const run = repository.run(batch.run.id);
        if (run?.state === "claimed" || run?.state === "submitted") repository.finish(batch.run.id, submitted ? "unknown" : "failed", publicFault(error).code);
        throw error;
      } finally { this.prompting = false; this.promptTask = undefined; }
      this.runId = null;
      this.update({ status: "idle", activity: null });
    }
  }
  /** Serialises session.configure between the pump and model changes. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.configuring.catch(() => {}).then(work);
    this.configuring = task;
    return task;
  }
  // Model/thinking changes queue behind start/stop and each other but not behind the running turn:
  // Pi 1.2.0 re-reads agent.state.model/thinkingLevel before every next request (AgentSession's prepareNextTurnWithContext),
  // and each request resolves its API key when it starts, so in-flight requests are unaffected.
  reconfigure(operation: () => Promise<void>): Promise<void> {
    const task = this.operations.catch(() => {}).then(async () => {
      if (this.stopping) throw new RuntimeFault("stopping", "Shutting down.");
      await operation();
    });
    this.operations = task;
    return task;
  }
  /** Start: pauses the pump and waits for it, then runs exclusively. */
  private async operation(operation: () => Promise<void>): Promise<void> {
    this.pauses++;
    const task = this.operations.catch(() => {}).then(async () => {
      if (this.stopping) throw new RuntimeFault("stopping", "Shutting down.");
      await this.pump;
      await operation();
    });
    this.operations = task;
    try { await task; } finally { this.pauses--; }
  }
  async changeModel(model: PreparedModel): Promise<PreparedModel> {
    try {
      return await this.exclusive(async () => {
        const actual = await this.session!.configure(model.selection);
        this.model = { ...model, selection: { ...model.selection, thinkingLevel: model.selection.thinkingLevel === "auto" ? "auto" : actual } };
        // A running turn keeps its status; only clear a previous error.
        this.update(this.prompting ? { error: null } : { status: "idle", activity: null, error: null });
        return this.model;
      });
    } catch (error) {
      // configure restores the previous credentials when setModel rejects, so a running turn keeps
      // its old model; only an idle session is rebuilt from the saved selection.
      // The HTTP caller reports the failure; a running turn is not marked as failed by it.
      if (this.prompting) throw publicFault(error);
      await this.session?.dispose(); this.session = undefined;
      this.fail(error); throw publicFault(error);
    }
  }
  async abort(): Promise<void> { if (this.prompting) this.session?.requestAbort(); await this.promptTask; }
  async stop(): Promise<void> {
    this.stopping = true; this.inputVersion++; this.session?.requestAbort();
    await this.pump;
    await this.operations.catch(() => {});
    await this.session?.dispose(); this.session = undefined;
    this.runId = null;
    this.update({ status: "stop", activity: null, error: null });
    this.stopping = false;
  }
}
