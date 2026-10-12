import type { MessageQuote } from "./quotes.js";
export interface MemberIdentity { id: string; kind: "user" | "bot"; name: string; /** A deleted Bot (its old messages stay, v15). */ deleted?: boolean; }
/** Channel notice / thread summary (A37): one current version, no edit history. */
/** `chatId` / `title`: where it happened — the chat itself, or for a channel row one of its threads. */
export interface ChatHint { kind: "reaction" | "note"; chatId: string; chatType: string; title: string; actor: string; detail: string; createdAt: number }
export interface ChatNote { text: string; updatedBy: MemberIdentity; updatedAt: number; version: number; }
/** A project grouping channels (A37); organisation only, it grants no access. */
export interface Section { id: string; name: string; position: number; createdAt: number; updatedAt: number; }
export interface Chat {
  id: string; type: "dm" | "channel" | "thread"; title: string; ownerId: string;
  memberIds: string[]; createdAt: number; updatedAt: number; lastMessage: string | null;
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
/** A thread as seen from its channel: under the root message and in the thread list. */
export interface ThreadInfo { id: string; title: string; status: "open" | "done"; replies: number; lastReplyAt: number | null; }
export interface OutgoingFile { name: string; mimeType: string; data: Uint8Array; }
export interface Attachment { id: string; name: string; mimeType: string; size: number; }
export interface MessageSource { historyId: number; toolCallId: string; }
/** A Bot's question card (messages.ask, A36). The Bot's tool call waits for it to settle. */
export interface QuestionOption { label: string; value?: string; description?: string; style?: "default" | "primary" | "danger"; }
export interface QuestionSpec { question: string; detail?: string; options: QuestionOption[]; multiple: boolean; allowCustom: boolean; }
/** pending: the tool is waiting; ignored: the tool stopped waiting (new message, abort, stop, restart). */
export type QuestionState = "pending" | "answered" | "dismissed" | "ignored";
export interface QuestionAnswer { selected: number[]; custom: string | null; }
export interface Question extends QuestionSpec { state: QuestionState; answer: QuestionAnswer | null; settledAt: number | null; }
export interface ChatMessage {
  id: string; chatId: string; sequence: number; sender: MemberIdentity;
  content: string; createdAt: number; attachments: Attachment[]; source: MessageSource | null; question: Question | null;
  /** Members @-mentioned in the text, resolved when the message was saved (channels and threads). */
  mentions: string[];
  /** Channel messages: the thread started from this message. */
  thread: ThreadInfo | null;
  /** Channel copy of a thread reply ("同时发到频道") or a thread's conclusion: that thread. */
  echoOf: { id: string; title: string } | null;
  /** The message this one replies to (same chat), with the start of its text; null when that message is gone. */
  replyTo: { id: string; senderId: string; content: string } | null;
  /** Emoji marks, in the order each emoji was first used. */
  reactions: { emoji: string; memberIds: string[] }[];
  /** Partial quotes, the Nth marked `[[qN]]` in the content (A44). */
  quotes: MessageQuote[];
}
export interface MessageDraft { content: string; attachmentIds: string[]; clientMessageId?: string; /** Reply to this message (same chat). */ replyTo?: string; }
/** A partial quote as a sender asks for it: the source message and the passage (A44). */
export interface QuoteDraft { messageId: string; text: string; }
export class ChatError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
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
