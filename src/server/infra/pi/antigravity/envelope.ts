import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { uuidFrom } from "./client.js";

/** The IDs and labels around a request, as Antigravity's CLI sends them (A91), ported from pi-antigravity (MIT):
 * a conversation and trajectory from the session, the step (how many turns the request has) and the request's
 * number in the session. */
export function envelope(runtime: string, modelEnum: string | undefined, turns: number, context: TranscriptContext, sessionId: string | undefined) {
  const step = Math.max(1, turns);
  const seed = sessionId?.trim() ? `session:${sessionId.trim()}` : undefined;
  const conversation = seed ? uuidFrom(`antigravity:conv:${seed}`) : randomUUID();
  const trajectory = seed ? uuidFrom(`antigravity:traj:${seed}`) : randomUUID();
  const claude = runtime.startsWith("claude-") ? "true" : "false";
  const labels: Record<string, string> = { last_step_index: String(Math.max(0, turns - 1)), request_id: `${trajectory}-${answered(context)}`,
    trajectory_id: trajectory, used_claude: claude, used_claude_conservative: claude, used_non_gemini_model: runtime.startsWith("gemini-") ? "false" : "true" };
  if (modelEnum) labels.model_enum = modelEnum;
  // The previous turn's execution, from the second step on.
  if (step > 1) labels.last_execution_id = uuidFrom(`antigravity:exec:${trajectory}:${step - 1}`);
  return { requestId: `agent/${conversation}/${Date.now()}/${trajectory}/${step}`, sessionId: int64(sessionId), labels };
}

/** How many answers the session has had: the same across retries of one turn. */
const answered = (context: TranscriptContext) =>
  context.messages.filter(message => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted").length;

const tries = new Map<string, number>();
/** The session a request says it is in. The backend queues a session's requests behind one another, and a stream that
 * broke may still be generating there, so every request after the first for one turn (Pi's retry, an empty answer
 * asked again) says it is in a session of its own. */
export function attemptSession(sessionId: string | undefined, context: TranscriptContext): string | undefined {
  const turn = `${sessionId ?? "-"}:${answered(context)}`;
  const count = tries.get(turn) ?? 0;
  tries.delete(turn);
  tries.set(turn, count + 1);
  if (tries.size > 64) tries.delete(tries.keys().next().value!);
  if (count === 0) return sessionId;
  return sessionId?.trim() ? `${sessionId}:r${count}` : randomUUID();
}

/** A signed 64-bit session number: from the session when there is one, else random. */
function int64(seed: string | undefined): string {
  const value = seed?.trim();
  if (value && /^-?\d+$/.test(value) && BigInt(value) >= -(1n << 63n) && BigInt(value) < (1n << 63n)) return value;
  const bytes = value ? createHash("sha256").update(`antigravity:session:${value}`).digest() : randomBytes(8);
  return bytes.readBigInt64LE(0).toString();
}
