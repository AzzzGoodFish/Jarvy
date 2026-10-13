import { LIVE_OUTPUT_END, LIVE_STEPS, LIVE_TEXT, type LiveChat, type LiveEvent, type LiveOutput, type LivePatch, type LiveStep, type LiveTurn,
  type LiveUpdate } from "../../shared/live.js";
import { liveInput, sentChat } from "./live-input.js";

/** How often changes go out: streamed text and quick tool calls are batched over this long. */
const FLUSH_MS = 100;
type Listener = (update: LiveUpdate) => void;

/** A long output keeps its start and end. */
export function liveOutput(text: string): LiveOutput | null {
  if (!text) return null;
  if (text.length <= 2 * LIVE_OUTPUT_END) return { head: text, tail: "", omitted: 0 };
  return { head: text.slice(0, LIVE_OUTPUT_END), tail: text.slice(-LIVE_OUTPUT_END), omitted: text.length - 2 * LIVE_OUTPUT_END };
}

/** The turn one Bot is running, in memory only (A47): its steps as they start, stream and end. A page that opens the
 * Bot's DM gets the turn so far, then the changes, batched every 100 ms. When the turn ends it is dropped — what it did
 * is in History. Bounded: `LIVE_STEPS` steps (the oldest finished ones go first), the latest `LIVE_TEXT` characters
 * of each thinking or text block, the two ends of each output. */
export class LiveTurns {
  private turn: LiveTurn | null = null;
  private readonly steps = new Map<string, LiveStep>();
  private readonly blocks = new Map<string, string>();
  private compaction: string | null = null;
  private retry: string | null = null;
  private counter = 0;
  private pending: LivePatch[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Map<Listener, () => void>();
  constructor(private readonly chat: (chatId: string) => LiveChat | null) {}

  /** Listens from now on and returns the turn so far (null when the Bot is not running one). Pending changes go to
   * the earlier listeners first, so the snapshot and the next patch never overlap. */
  subscribe(listener: Listener, close: () => void): { turn: LiveTurn | null; unsubscribe: () => void } {
    this.flush();
    this.listeners.set(listener, close);
    return { turn: this.turn ? structuredClone(this.turn) : null, unsubscribe: () => { this.listeners.delete(listener); } };
  }
  /** Ends every listener's stream (the Bot was deleted, or the server is stopping). */
  close() { for (const close of [...this.listeners.values()]) close(); this.listeners.clear(); }

  event(event: LiveEvent): void {
    if (event.type === "start") { this.flush(); this.reset(); this.turn = { startedAt: Date.now(), steps: [], dropped: 0 }; this.emit({ type: "start", turn: structuredClone(this.turn) }); return; }
    if (!this.turn) return;
    switch (event.type) {
      case "end": {
        // Whatever is still open ends with the turn: done if it completed, failed if it was cut short.
        for (const step of this.turn.steps) if (step.state === "running") this.finish(step, event.outcome !== "completed");
        this.flush();
        this.emit({ type: "end", outcome: event.outcome, endedAt: Date.now() });
        this.reset();
        return;
      }
      case "block_start": this.blocks.set(event.key, this.add({ kind: event.kind, text: "", omitted: 0 }).id); return;
      case "block_delta": {
        let id = this.blocks.get(event.key);
        if (!id) { id = this.add({ kind: event.kind, text: "", omitted: 0 }).id; this.blocks.set(event.key, id); }
        const step = this.steps.get(id);
        if (!step) return;
        const text = (step.text ?? "") + event.delta, over = Math.max(0, text.length - LIVE_TEXT);
        step.text = text.slice(over); step.omitted = (step.omitted ?? 0) + over;
        this.queue({ op: "text", id, append: event.delta });
        return;
      }
      case "block_end": {
        const step = this.steps.get(this.blocks.get(event.key) ?? "");
        if (step) this.finish(step, false);
        this.blocks.delete(event.key);
        return;
      }
      case "tool_start":
        this.add({ id: event.id, kind: "tool", parentId: event.parentId, tool: event.name, input: liveInput(event.name, event.args, this.chat) });
        return;
      case "tool_end": {
        const step = this.steps.get(event.id);
        if (!step) return;
        step.output = liveOutput(event.output);
        if (step.input?.action === "messages.send" && !event.failed) step.input.chat = sentChat(event.output, this.chat) ?? step.input.chat;
        this.finish(step, event.failed);
        return;
      }
      case "compaction_start": this.compaction = this.add({ kind: "compaction" }).id; return;
      case "compaction_end": {
        const step = this.steps.get(this.compaction ?? "");
        this.compaction = null;
        if (!step) return;
        step.tokensBefore = event.tokensBefore; step.tokensAfter = event.tokensAfter; step.output = event.error ? liveOutput(event.error) : null;
        this.finish(step, event.failed);
        return;
      }
      case "retry_start": {
        // A new attempt closes the previous one: it failed.
        const previous = this.steps.get(this.retry ?? "");
        if (previous?.state === "running") this.finish(previous, true);
        this.retry = this.add({ kind: "retry", attempt: event.attempt, maxAttempts: event.maxAttempts, output: liveOutput(event.error) }).id;
        return;
      }
      case "retry_end": {
        const step = this.steps.get(this.retry ?? "");
        this.retry = null;
        if (step) { if (event.error) step.output = liveOutput(event.error); this.finish(step, event.failed); }
        return;
      }
    }
  }

  private add(fields: Partial<LiveStep> & Pick<LiveStep, "kind">): LiveStep {
    const turn = this.turn!;
    if (turn.steps.length >= LIVE_STEPS) {
      const index = Math.max(0, turn.steps.findIndex(step => step.state !== "running")), [gone] = turn.steps.splice(index, 1);
      this.steps.delete(gone!.id); turn.dropped++; this.queue({ op: "drop", id: gone!.id });
    }
    const step: LiveStep = { id: `s${++this.counter}`, state: "running", startedAt: Date.now(), endedAt: null, parentId: null, ...fields };
    turn.steps.push(step); this.steps.set(step.id, step);
    this.queue({ op: "step", step: structuredClone(step) });
    return step;
  }
  private finish(step: LiveStep, failed: boolean) {
    step.state = failed ? "failed" : "ok"; step.endedAt = Date.now();
    this.queue({ op: "step", step: structuredClone(step) });
  }
  private queue(patch: LivePatch) {
    this.pending.push(patch);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }
  /** Sends the pending changes as one patch: text streamed into the same step is joined, and a step sent whole
   * replaces what came before it for that step. A step is copied when it is queued, so text streamed after that
   * follows it as its own patch. */
  private flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending.length) return;
    const patches: LivePatch[] = [];
    for (const patch of this.pending) {
      const last = patches.at(-1);
      if (patch.op === "text" && last?.op === "text" && last.id === patch.id) { last.append += patch.append; continue; }
      if (patch.op === "step") {
        for (let index = patches.length - 1; index >= 0; index--) { const item = patches[index]!; if ((item.op === "step" ? item.step.id : item.id) === patch.step.id) patches.splice(index, 1); }
        patches.push(patch);
        continue;
      }
      patches.push({ ...patch });
    }
    this.pending = [];
    this.emit({ type: "patch", patches });
  }
  private emit(update: LiveUpdate) {
    for (const listener of [...this.listeners.keys()]) {
      try { listener(update); } catch (error) { console.error("[live] listener failed", { error }); }
    }
  }
  private reset() {
    this.turn = null; this.steps.clear(); this.blocks.clear(); this.compaction = null; this.retry = null; this.counter = 0; this.pending = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
