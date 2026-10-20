/** How full a Bot's context is, from what the model itself reported — never Pi's characters-÷-4 estimate, which reads
 * about half the real size for Chinese, code and JSON (fish m1270). */

/** The parts of a Pi session entry this reads. */
export interface ContextEntry {
  type: string;
  message?: { role?: string; stopReason?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } };
}
export interface ReportedContext {
  /** The size the model reported with its latest reply; null until there is one, and after a compaction until the next. */
  tokens: number | null;
  /** A failed request was dropped from the context after that reply (Pi records a `context_edit` when it gives up on
   * an attempt, before retrying or compacting), so the context the next request sends differs from `tokens`. */
  stale: boolean;
}

const reported = (usage: NonNullable<ContextEntry["message"]>["usage"]) =>
  usage ? usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;

/** Walks the session's current branch back from the end to the latest reply that carries usage. */
export function reportedContext(branch: readonly ContextEntry[]): ReportedContext {
  let stale = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "compaction") return { tokens: null, stale: false };
    if (entry.type === "context_edit") { stale = true; continue; }
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const tokens = reported(message.usage);
    if (tokens > 0) return { tokens, stale };
  }
  return { tokens: null, stale: false };
}
