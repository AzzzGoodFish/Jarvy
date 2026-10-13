import { request } from "./api";

export type HistoryContent =
  | { type: "text" | "reasoning"; text: string }
  | { type: "image"; mime_type: string; data: string }
  | { type: "tool_call"; tool_call_id: string; name: string; arguments: unknown }
  | { type: "tool_result"; tool_call_id: string; name: string; is_error: boolean; result: { content: HistoryContent[]; details?: unknown } };
/** A record in the timeline: the start of its text, its tool steps (a call, or a result that may have failed), its image count. */
export interface HistorySummary { id: number; timestamp: number; role: string; model: { provider: string; id: string } | null; preview: string;
  tools: { kind: "call" | "result"; name: string; error?: true }[]; images: number; }
export interface HistoryRecord extends Omit<HistorySummary, "preview" | "tools" | "images"> {
  usage: unknown; extra: Record<string, unknown>;
  message: { content: HistoryContent[]; tools?: { name: string; description: string; parameters: unknown }[]; tools_removed?: unknown; stop_reason?: string; error?: string };
}
export interface HistoryLink { id: number; tool_call_id: string; role: string; }
export interface HistoryDetail { record: HistoryRecord; links: HistoryLink[]; }
export const historyApi = {
  read: (botId: string, id: number) => request<HistoryDetail>(`/bots/${botId}/history/${id}`),
};
