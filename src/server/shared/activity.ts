import type { MessageSource } from "./chat.js";
import type { HistorySummary } from "./history.js";

/** Descending timestamp, then History before Chat at ties, then descending source ID. */
export type ActivityCursor = { kind: "history"; timestamp: number; id: number } | { kind: "chat"; timestamp: number; id: string };
export interface ChatActivitySummary {
  id: string; chatId: string; chatTitle: string; sequence: number; timestamp: number;
  preview: string; attachmentCount: number; source: MessageSource | null;
}
export type BotActivityItem = { kind: "chat"; record: ChatActivitySummary } | { kind: "history"; record: HistorySummary };
export interface BotActivityPage { items: BotActivityItem[]; nextBefore: ActivityCursor | null; }
