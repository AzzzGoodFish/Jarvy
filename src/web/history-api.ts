import { request } from "./api";
import type { InputDigest, ParsedInput } from "../contract/inputs";

export type HistoryContent =
  | { type: "text" | "reasoning"; text: string }
  | { type: "image"; mime_type: string; data: string }
  | { type: "tool_call"; tool_call_id: string; name: string; arguments: unknown }
  | { type: "tool_result"; tool_call_id: string; name: string; is_error: boolean; result: { content: HistoryContent[]; details?: unknown } };
/** A record in the timeline: the start of its text, its tool steps (a call, or a result that may have failed), its image count. */
export interface HistorySummary { id: number; timestamp: number; role: string; model: { provider: string; id: string } | null; preview: string;
  tools: { kind: "call" | "result"; name: string; error?: true }[]; images: number;
  /** An input record's batch as it reads (A22). */
  input?: InputDigest; }
export interface HistoryRecord extends Omit<HistorySummary, "preview" | "tools" | "images" | "input"> {
  usage: unknown; extra: Record<string, unknown>;
  message: { content: HistoryContent[]; tools?: { name: string; description: string; parameters: unknown }[]; tools_removed?: unknown; stop_reason?: string; error?: string };
}
export interface HistoryLink { id: number; tool_call_id: string; role: string; }
/** `input`: an input record's batch, parsed by the server (A22). */
export interface HistoryDetail { record: HistoryRecord; links: HistoryLink[]; input?: ParsedInput; }
export const historyApi = {
  read: (botId: string, id: number) => request<HistoryDetail>(`/bots/${botId}/history/${id}`),
};
