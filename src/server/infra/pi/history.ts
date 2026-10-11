import type { Message, TextContent, ThinkingContent, ImageContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { SessionHeader, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { HistoryContent, HistoryDraft, HistoryMessage, JsonValue } from "../../shared/history.js";

const value = (input: unknown): JsonValue => JSON.parse(JSON.stringify(input)) as JsonValue;
const stops: Record<string, string> = { pending: "pending", stop: "completed", length: "length_limit", toolUse: "tool_call", error: "error", aborted: "cancelled", deferred: "deferred" };

/** Converts finalized Pi messages only. No database/file access or event scheduling. */
export class PiHistoryAdapter {
  constructor(private readonly header: SessionHeader) {}
  convert(entry: SessionMessageEntry): HistoryDraft | null {
    const source = entry.message;
    if (!["system", "user", "assistant", "toolResult"].includes(source.role)) return null;
    const m = source as Message;
    const pi: Record<string, JsonValue> = {
      session_id: this.header.id, ...(this.header.version === undefined ? {} : { source_version: this.header.version }),
      entry_id: entry.id, parent_id: entry.parentId, recorded_at: entry.timestamp,
    };
    const protocolBlocks: Record<string, JsonValue> = {};
    const content = (input: string | (TextContent | ThinkingContent | ImageContent | ToolCall)[], path: string): HistoryContent[] => {
      const blocks = typeof input === "string" ? [{ type: "text" as const, text: input }] : input;
      return blocks.map((block, index) => {
        const ref = `${path}/${index}`, extra: Record<string, JsonValue> = {};
        if (block.type === "text" && block.textSignature !== undefined) extra.textSignature = block.textSignature;
        if (block.type === "thinking") {
          if (block.thinkingSignature !== undefined) extra.thinkingSignature = block.thinkingSignature;
          if (block.redacted !== undefined) extra.redacted = block.redacted;
        }
        if (block.type === "toolCall") {
          if (block.thoughtSignature !== undefined) extra.thoughtSignature = block.thoughtSignature;
          if (block.namespace !== undefined) extra.namespace = block.namespace;
        }
        if (Object.keys(extra).length) protocolBlocks[ref] = extra;
        switch (block.type) {
          case "text": return { type: "text", text: block.text };
          case "thinking": return { type: "reasoning", text: block.thinking };
          case "image": return { type: "image", mime_type: block.mimeType, data: block.data };
          case "toolCall": return { type: "tool_call", tool_call_id: block.id, name: block.name, arguments: value(block.arguments) };
        }
      });
    };
    const message: HistoryMessage = { content: [] };
    let model: HistoryDraft["model"] = null, usage: JsonValue = null;
    if (m.role === "toolResult") {
      message.content = [{ type: "tool_result", tool_call_id: m.toolCallId, name: m.toolName, is_error: m.isError,
        result: { content: content(m.content, "/content/0/result/content"), ...(m.details === undefined ? {} : { details: value(m.details) }) } }];
      if (m.usage) usage = this.usage(m.usage);
      if (m.nestedCalls !== undefined) pi.nested_calls = value(m.nestedCalls);
    } else {
      message.content = content(m.content, "/content");
      if (m.role === "system") {
        if (m.sections) {
          const sections: Record<string, JsonValue> = {};
          for (const [name, text] of Object.entries(m.sections)) {
            sections[name] = text === null ? null : message.content.length;
            if (text !== null) message.content.push({ type: "text", text });
          }
          pi.sections = sections;
        }
        if (m.toolsAdded) {
          const toolProtocol: Record<string, JsonValue> = {};
          message.tools = m.toolsAdded.map((tool, index) => {
            const { name, description, parameters, ...specific } = tool;
            if (Object.keys(specific).length) toolProtocol[index] = value(specific);
            return { name, description, parameters: value(parameters) };
          });
          if (Object.keys(toolProtocol).length) pi.tools = toolProtocol;
        }
        if (m.toolsRemoved) message.tools_removed = value(m.toolsRemoved);
      }
      if (m.role === "assistant") {
        model = { provider: m.provider, id: m.model };
        usage = this.usage(m.usage);
        message.stop_reason = stops[m.stopReason];
        if (m.errorMessage !== undefined) message.error = m.errorMessage;
        pi.api = m.api;
        if (m.responseId !== undefined) pi.response_id = m.responseId;
        if (m.responseModel !== undefined) pi.response_model = m.responseModel;
        if (m.providerThinkingLevel !== undefined) pi.provider_thinking_level = m.providerThinkingLevel;
        if (m.thinkingLevel !== undefined) pi.thinking_level = m.thinkingLevel;
        if (m.rawStopReason !== undefined) pi.raw_stop_reason = m.rawStopReason;
        if (m.endTurn !== undefined) pi.end_turn = m.endTurn;
        if (m.diagnostics !== undefined) pi.diagnostics = value(m.diagnostics);
        if (m.deferred !== undefined) pi.deferred = value(m.deferred);
      }
    }
    if (Object.keys(protocolBlocks).length) pi.blocks = protocolBlocks;
    return { timestamp: m.timestamp, role: m.role === "toolResult" ? "tool" : m.role, model, usage, message, extra: { pi } };
  }
  private usage(u: Usage): JsonValue {
    return {
      input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cacheRead,
      cache_write_tokens: u.cacheWrite, total_tokens: u.totalTokens,
      ...(u.cacheWrite1h === undefined ? {} : { cache_write_1h_tokens: u.cacheWrite1h }),
      ...(u.reasoning === undefined ? {} : { reasoning_tokens: u.reasoning }),
      cost: { input: u.cost.input, output: u.cost.output, cache_read: u.cost.cacheRead, cache_write: u.cost.cacheWrite, total: u.cost.total },
    };
  }
}
