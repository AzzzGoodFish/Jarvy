import type { Chat } from "./api";
import type { InfoPage } from "./channel/ChannelInfo";

/** The right-hand pane (A37 P2): a channel's thread list or info (with its member page), a Bot's DMs with other Bots,
 * search inside a chat, or one thread (expandable over the main area). */
export type Pane = { kind: "threads" } | { kind: "info"; page: InfoPage } | { kind: "botdms" } | { kind: "search"; chat: Chat }
  | { kind: "thread"; id: string; parentId: string; mode: "pane" | "full"; summary?: boolean; focus?: string };
