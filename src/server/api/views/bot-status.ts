import type { BotService } from "../../service/bot/service.js";
import type { BotStatus } from "../../shared/runtime.js";

/** phase/errorCode are existing HTTP fields, not the business lifecycle model. */
export function botStatusView(status: ReturnType<BotService["status"]>): BotStatus & { status: "stop" | "idle" | "running"; activity: string | null } {
  const phase = status.error ? "error" : status.status === "stop" ? "stopped" : status.status === "idle" ? "idle"
    : status.activity === "reasoning" ? "thinking" : status.activity === "texting" ? "texting" : status.activity === "tool_calling" ? "tool" : status.activity === "asking" ? "asking" : "dispatching";
  return { botId: status.botId, phase, status: status.status, activity: status.activity, runId: status.runId,
    errorCode: status.error?.code ?? null, error: status.error?.message ?? null, ...(status.error?.params ? { errorParams: status.error.params } : {}),
    ...(status.context ? { context: { tokens: status.context.tokens, contextWindow: status.context.limit, percent: status.context.tokens === null ? null : status.context.tokens / status.context.limit * 100 } } : {}) };
}
