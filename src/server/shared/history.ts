export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type HistoryRole = "system" | "user" | "assistant" | "tool";
export type HistoryContent =
  | { type: "text" | "reasoning"; text: string }
  | { type: "image"; mime_type: string; data: string }
  | { type: "tool_call"; tool_call_id: string; name: string; arguments: JsonValue }
  | { type: "tool_result"; tool_call_id: string; name: string; is_error: boolean; result: { content: HistoryContent[]; details?: JsonValue } };
export interface HistoryMessage {
  content: HistoryContent[];
  tools?: { name: string; description: string; parameters: JsonValue }[];
  tools_removed?: JsonValue;
  stop_reason?: string;
  error?: string;
}
export interface HistoryDraft {
  timestamp: number;
  role: HistoryRole;
  model: { provider: string; id: string } | null;
  usage: JsonValue;
  message: HistoryMessage;
  extra: { [adapter: string]: JsonValue };
}
export interface HistoryRecord extends HistoryDraft { id: number; }
/** A History record in a list (A45: structure, worded by the reader): the start of its text and reasoning, its tool
 * steps in order (a call, or a result that may have failed) and how many images it holds. */
export interface HistorySummary {
  id: number; timestamp: number; role: HistoryRole; model: HistoryDraft["model"]; preview: string; tools: HistoryTool[]; images: number;
}
export interface HistoryTool { kind: "call" | "result"; name: string; error?: true; }
export interface HistoryPage { items: HistorySummary[]; nextBefore: number | null; }
export interface HistoryLink { id: number; tool_call_id: string; role: HistoryRole; }
/** One model's usage over a period, summed from the Bot's History. `cost` is null when no call of that model was
 * priced (its configured price is zero or missing), so an unpriced model never reads as free. */
export interface ModelUsage {
  provider: string; model: string; calls: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null;
}


/** Agent-facing reads omit billing and adapter diagnostics; message content remains complete. */
export type HistoryReadMode = "summary" | "detail";
export type HistoryReadDetail = Pick<HistoryRecord, "id" | "timestamp" | "role" | "model" | "message">;
/** A summary as history.read gives it: one line of text (see Memory). */
export type HistoryReadSummary = Pick<HistorySummary, "id" | "timestamp" | "role" | "model" | "preview">;
export interface HistoryReadResult {
  mode: HistoryReadMode;
  records: (HistoryReadSummary | HistoryReadDetail)[];
  missingIds: number[];
}
