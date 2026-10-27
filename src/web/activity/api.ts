import { request } from "../api";
import { type ChatMessage } from "../../contract/chat";
import type { HistorySummary } from "../history-api";

export interface ChatActivity {
  id: string; chatId: string; chatTitle: string; sequence: number; timestamp: number;
  preview: string; attachmentCount: number; source: { historyId: number; toolCallId: string } | null;
}
export type ActivityItem = { kind: "chat"; record: ChatActivity } | { kind: "history"; record: HistorySummary };
export type Selection = { kind: "chat"; id: string } | { kind: "history"; id: number };
export interface ActivityPage { items: ActivityItem[]; nextBefore: string | null; }
export interface ChatDetail { chat: { id: string; title: string }; message: ChatMessage; }
export const activityApi = {
  list: (botId: string, before?: string) => request<ActivityPage>(`/bots/${botId}/activity${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`),
  message: (botId: string, id: string) => request<ChatDetail>(`/bots/${botId}/activity/messages/${id}`),
};
