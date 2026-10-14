import type { ChatService } from "../chat/service.js";
import type { BotStatus } from "./contracts.js";

/** One Bot's run state as the service knows it, before it is shaped for a viewer. */
export interface RosterEntry {
  id: string;
  name: string;
  /** The agent Bot (A48). */
  agent: boolean;
  status: BotStatus;
  /** Chats of the messages the current run is handling; empty when not running. */
  runChatIds: readonly string[];
  /** `bot_runs.error_code` of the Bot's latest run. */
  errorCode: string | null;
}

/** `bots.list` (A43): every Bot's name and run state. Read-only; the only per-viewer filtering is that
 * chats the viewer cannot read are counted, not named. Self first, then by name. */
export function botRows(chats: ChatService, viewerId: string, entries: readonly RosterEntry[]) {
  const rows = entries.map(entry => {
    const running = entry.status.status === "running";
    const visible: { id: string; type: string; title: string }[] = [];
    let hidden = 0;
    if (running) for (const chatId of new Set(entry.runChatIds)) {
      const chat = chats.get(viewerId, chatId);
      if (chat) visible.push({ id: chat.id, type: chat.type, title: chat.title }); else hidden++;
    }
    return { self: entry.id === viewerId, row: { name: entry.name, ...(entry.id === viewerId ? { self: true } : {}), ...(entry.agent ? { agent: true } : {}), status: entry.status.status,
      ...(running && entry.status.activity ? { activity: entry.status.activity } : {}),
      ...(visible.length ? { chats: visible } : {}), ...(hidden ? { otherChats: hidden } : {}),
      ...(entry.errorCode ? { error: entry.errorCode } : {}) } };
  });
  rows.sort((a, b) => Number(b.self) - Number(a.self) || a.row.name.localeCompare(b.row.name));
  return rows.map(item => item.row);
}
