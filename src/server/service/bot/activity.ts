import type { ActivityCursor, BotActivityItem, BotActivityPage, ChatActivitySummary } from "../../shared/activity.js";
import type { HistorySummary } from "../../shared/history.js";

/** Read-only composition; timestamp proximity does not create a History source link. */
export function activityPage(messages: ChatActivitySummary[], history: HistorySummary[], limit: number): BotActivityPage {
  const candidates: BotActivityItem[] = [
    ...messages.map(record => ({ kind: "chat" as const, record })),
    ...history.map(record => ({ kind: "history" as const, record })),
  ];
  candidates.sort((a, b) => {
    if (a.record.timestamp !== b.record.timestamp) return b.record.timestamp - a.record.timestamp;
    if (a.kind !== b.kind) return a.kind === "history" ? -1 : 1;
    return a.record.id === b.record.id ? 0 : a.record.id > b.record.id ? -1 : 1;
  });
  const items = candidates.slice(0, limit), last = items.at(-1);
  const position: ActivityCursor | null = !last ? null : last.kind === "history"
    ? { kind: "history", timestamp: last.record.timestamp, id: last.record.id }
    : { kind: "chat", timestamp: last.record.timestamp, id: last.record.id };
  return { items, nextBefore: candidates.length > limit ? position : null };
}
