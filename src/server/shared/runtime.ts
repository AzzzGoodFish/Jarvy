export interface ModelSelection { connectionId: string; modelId: string; thinkingLevel: string; }
export type RunState = "claimed" | "submitted" | "completed" | "failed" | "interrupted" | "unknown" | "cancelled";
export interface BotRun { id: string; botId: string; state: RunState; selection: ModelSelection; createdAt: number; endedAt: number | null; errorCode: string | null; }
export interface SessionRef { botId: string; file: string; sessionId: string | null; persisted: boolean; }
export type BotPhase = "stopped" | "starting" | "idle" | "dispatching" | "thinking" | "texting" | "tool" | "asking" | "compacting" | "retrying" | "aborting" | "error";
export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null; }
export interface BotStatus { context?: ContextUsage; botId: string; phase: BotPhase; runId: string | null; errorCode: string | null; error: string | null; }
export class RuntimeFault extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export function publicFault(error: unknown): RuntimeFault {
  return error instanceof RuntimeFault ? error : new RuntimeFault("runtime_failed", "运行失败，请检查模型配置或运行记录。", 500);
}
