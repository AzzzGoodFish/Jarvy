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
export interface HistorySummary {
  id: number; timestamp: number; role: HistoryRole; model: HistoryDraft["model"]; preview: string;
}
export interface HistoryPage { items: HistorySummary[]; nextBefore: number | null; }
export interface HistoryLink { id: number; tool_call_id: string; role: HistoryRole; }


/** Agent-facing reads omit billing and adapter diagnostics; message content remains complete. */
export type HistoryReadMode = "summary" | "detail";
export type HistoryReadDetail = Pick<HistoryRecord, "id" | "timestamp" | "role" | "model" | "message">;
export interface HistoryReadResult {
  mode: HistoryReadMode;
  records: (HistorySummary | HistoryReadDetail)[];
  missingIds: number[];
}
