import type { Chat, ChatMessage } from "./chat.js";
import type { Bot, BotStatus } from "./bots.js";
import type { FollowedSummary } from "./threads.js";

/** The page's live events (`GET /api/events`, A72). Each says what changed and carries it as the person sees it now,
 * so the page puts it in place instead of reading again what it shows. Every event but `ready` and `heartbeat` has an
 * id; a page that reconnects passes the last one (`Last-Event-ID`, or `?after=` on a new connection) and is sent what
 * it missed, when the server still has it. */
export interface LiveChat {
  /** The chat as its row shows it: a sidebar row, a Bot's DM with another Bot, or a thread. */
  chat: Chat;
  /** A thread's channel: its row hints at what happened in its threads. */
  parent?: Chat;
  /** The followed threads in numbers, when a followed thread changed (A69). */
  followed?: FollowedSummary;
}
/** `message`: a new message; `message.updated`: one changed in place (marks, folded, a question's answer, the thread
 * under it). Either one comes with its chat. */
export interface LiveMessage extends LiveChat { message: ChatMessage }
/** A chat deleted, with its threads; the followed numbers without them. */
export interface LiveRemoved { chatId: string; followed: FollowedSummary }
/** A Bot's status; when it stops or goes idle, the Bot too (it may have changed itself during the turn). */
export interface LiveBot { botId: string; status: BotStatus; bot?: Bot }
/** Sent once a connection is open. `resumed`: what was missed since the id passed has been sent, and nothing needs
 * reading again; false on a first connection, or when the server no longer has all of it (restarted, or too long ago). */
export interface LiveReady { resumed: boolean }
