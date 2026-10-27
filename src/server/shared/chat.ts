import type { ErrorParams } from "./errors.js";
import type { Attachment, ChatHint, ChatNote, Member, MessageDraft, MessageQuote, MessageSource, Question, QuestionSpec, ThreadInfo } from "../../contract/chat.js";
export interface Chat {
  id: string; type: "dm" | "channel" | "thread"; title: string; ownerId: string;
  memberIds: string[]; createdAt: number; updatedAt: number; lastMessage: { content: string; quotes: MessageQuote[] } | null;
  sectionId: string | null; topic: string; parentId: string | null; rootMessageId: string | null; status: "open" | "done" | null;
  note: ChatNote | null;
  /** For the asking member: read position, unread count, and unread messages that @ them (all unread in a DM). */
  readSequence: number; unread: number; mentions: number;
  /** For the asking member (A41): messages delivered to them with an interrupt that they have not read
   * (DMs, @, replies) — the red count — and the newest queued delivery not seen yet (a mark on their message, a new
   * notice / summary version; a channel includes its threads) — the small hint line. */
  alerts: number; hint: ChatHint | null;
  /** Some of those unread deliveries @ you or reply to you: the hint line starts with 「[有人@我]」. */
  atMe: boolean;
  /** You muted it (免打扰): DMs and subscriptions stop interrupting you; @ and replies still do. */
  muted: boolean;
  /** Who wrote the last message (the second line of a channel row: 「名字：消息」). */
  lastSender: string | null;
  /** Threads only: whether the asking member follows it (only followed threads count as unread). */
  following: boolean;
  /** Channels and threads: whether the asking member subscribed (every new message is delivered to it). */
  subscribed: boolean;
  /** Pinned to the top of its sidebar group by the asking member (v15). */
  pinned: boolean;
}
export interface OutgoingFile { name: string; mimeType: string; data: Uint8Array; }
export interface ChatMessage {
  id: string; chatId: string; sequence: number; sender: Member;
  content: string; createdAt: number; attachments: Attachment[]; source: MessageSource | null; question: Question | null;
  /** Members @-mentioned in the text, resolved when the message was saved (channels and threads). */
  mentions: string[];
  /** Channel messages: the thread started from this message. */
  thread: ThreadInfo | null;
  /** Channel copy of a thread reply ("同时发到频道") or a thread's conclusion: that thread. */
  echoOf: { id: string; title: string } | null;
  /** The message this one replies to (same chat), with the start of its text; null when that message is gone. */
  replyTo: { id: string; senderId: string; content: string; quotes: MessageQuote[] } | null;
  /** Emoji marks, in the order each emoji was first used. */
  reactions: { emoji: string; memberIds: string[] }[];
  /** Partial quotes, the Nth marked `[[qN]]` in the content (A44). */
  quotes: MessageQuote[];
  /** The owner folded it to one line in the interface (A60). Only the interface reads it; a Bot's views leave it out. */
  folded: boolean;
}
export class ChatError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly code?: string, readonly params?: ErrorParams) { super(message); }
}

export interface DeliveryMessage extends MessageDraft {
  /** Checked partial quotes (A44), the Nth marked `[[qN]]`. */
  quotes?: readonly MessageQuote[];
  /** New files and their message are committed together. */
  files?: readonly OutgoingFile[];
  /** Runtime-bound provenance, never a caller-selected HTTP field. */
  source?: MessageSource | null;
  /** Only Bots ask questions; saved as a pending question card. */
  question?: QuestionSpec;
  /** Thread replies: also post a copy to the parent channel, in the same transaction. */
  alsoToChannel?: boolean;
}
