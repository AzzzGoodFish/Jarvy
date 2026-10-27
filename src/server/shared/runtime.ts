import type { ErrorCode, ErrorParams } from "../../contract/errors.js";
export interface ModelSelection { connectionId: string; modelId: string; thinkingLevel: string; }
export type RunState = "claimed" | "submitted" | "completed" | "failed" | "interrupted" | "unknown" | "cancelled";
export interface BotRun { id: string; botId: string; state: RunState; selection: ModelSelection; createdAt: number; endedAt: number | null; errorCode: string | null; }
export interface SessionRef { botId: string; file: string; sessionId: string | null; persisted: boolean; }
export type BotPhase = "stopped" | "starting" | "idle" | "dispatching" | "thinking" | "texting" | "tool" | "asking" | "compacting" | "retrying" | "aborting" | "error";
/** tokens: what the model reported with its latest reply. stale: a failed request was dropped from the context since. */
export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null; stale: boolean; }
export interface BotStatus { context?: ContextUsage; botId: string; phase: BotPhase; runId: string | null; errorCode: string | null; error: string | null; errorParams?: ErrorParams; }
export class RuntimeFault extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly status = 409, readonly params?: ErrorParams) { super(message); }
}
export function publicFault(error: unknown): RuntimeFault {
  return error instanceof RuntimeFault ? error : new RuntimeFault("runtime_failed", "The run failed. Check the model setup or the run records.", 500);
}
