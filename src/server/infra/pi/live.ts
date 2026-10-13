import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LiveEvent } from "../../shared/live.js";

/** Pi's session events → Jarvy's live events (A47). Streamed thinking and text are told apart by assistant message and
 * content index; a message that ends without closing a block (an error mid-stream) closes it. */
export class LiveTranslator {
  private message = 0;
  private readonly open = new Set<string>();
  translate(event: AgentSessionEvent): LiveEvent[] {
    switch (event.type) {
      case "message_start": if (event.message.role === "assistant") this.message++; return [];
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type !== "thinking_start" && update.type !== "thinking_delta" && update.type !== "thinking_end"
          && update.type !== "text_start" && update.type !== "text_delta" && update.type !== "text_end") return [];
        const key = `${this.message}:${update.contentIndex}`, kind = update.type.startsWith("thinking") ? "thinking" as const : "text" as const;
        const events: LiveEvent[] = [];
        if (!this.open.has(key) && !update.type.endsWith("_end")) { this.open.add(key); events.push({ type: "block_start", key, kind }); }
        if (update.type.endsWith("_delta") && "delta" in update && update.delta) events.push({ type: "block_delta", key, kind, delta: update.delta });
        if (update.type.endsWith("_end") && this.open.delete(key)) events.push({ type: "block_end", key });
        return events;
      }
      case "message_end": {
        if (event.message.role !== "assistant") return [];
        const prefix = `${this.message}:`, closing = [...this.open].filter(key => key.startsWith(prefix));
        for (const key of closing) this.open.delete(key);
        return closing.map(key => ({ type: "block_end", key }));
      }
      case "tool_execution_start":
        return [{ type: "tool_start", id: event.toolCallId, parentId: event.parentToolCallId ?? null, name: event.toolName, args: event.args }];
      case "tool_execution_end": return [{ type: "tool_end", id: event.toolCallId, output: resultText(event.result), failed: event.isError }];
      case "compaction_start": return [{ type: "compaction_start" }];
      case "compaction_end": return [{ type: "compaction_end", failed: !!event.errorMessage || event.aborted, error: event.errorMessage ?? null,
        tokensBefore: event.result?.tokensBefore ?? null, tokensAfter: event.result?.estimatedTokensAfter ?? null }];
      case "auto_retry_start": return [{ type: "retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts, error: event.errorMessage }];
      case "auto_retry_end": return [{ type: "retry_end", failed: !event.success, error: event.finalError ?? null }];
      default: return [];
    }
  }
}

/** A tool result's text parts (images as a marker); anything else as JSON. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) return content.map(part => part?.type === "text" ? String(part.text ?? "") : part?.type === "image" ? "[image]" : "").filter(Boolean).join("\n");
  if (typeof result === "string") return result;
  try { return JSON.stringify(result) ?? ""; } catch { return String(result); }
}
