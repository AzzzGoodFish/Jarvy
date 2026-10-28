/** Chats, messages and members as the interface sees them (A37, A41, A44, A60). */
import type { HostKeys } from "./environment.js";

/** A person or a Bot. `deleted`: a deleted Bot, still shown as the author of its old messages (v15). */
export interface Member { id: string; kind: "user" | "bot"; name: string; deleted?: boolean; }
/** A project grouping channels (A37); organisation only, it grants no access. */
export interface Section { id: string; name: string; position: number; createdAt: number; updatedAt: number; }
/** The newest queued delivery not seen yet (the sidebar's hint line). `chatId` / `title`: where it happened — the chat
 * itself, or for a channel row one of its threads. */
export interface ChatHint { kind: "reaction" | "note"; chatId: string; chatType: string; title: string; actor: string; detail: string; createdAt: number }
/** Channel notice / thread summary (A37): one current version, no edit history. */
export interface ChatNote { text: string; updatedBy: Member; updatedAt: number; version: number; }
/** A partial quote (A44): a message carries quotes as structure and marks where each one sits with `[[qN]]`. */
export interface MessageQuote {
  /** The quoted message; null once that message is gone. */
  messageId: string | null;
  senderId: string;
  /** The quoted passage, a snapshot of the source's text. */
  text: string;
}
/** A thread as seen from its channel: under the root message and in the thread list. */
export interface ThreadInfo { id: string; title: string; status: "open" | "done"; replies: number; lastReplyAt: number | null; }
export interface Attachment { id: string; name: string; mimeType: string; size: number; }
/** The largest file a message carries, from people and Bots alike (A66). */
export const ATTACHMENT_MAX_BYTES = 4 * 1024 ** 3;
/** The Bot turn and tool call that sent a message, to open it in the Bot's history. */
export interface MessageSource { historyId: number; toolCallId: string; }
/** A Bot's question card (messages.ask, A36). The Bot's tool call waits for it to settle. */
export interface QuestionOption { label: string; value?: string; description?: string; style?: "default" | "primary" | "danger"; }
export interface QuestionSpec { question: string; detail?: string; options: QuestionOption[]; multiple: boolean; allowCustom: boolean;
  /** A request for a secret (secrets.request, A52): the card takes the value through its own endpoint, never into the chat. */
  secret?: SecretAsk;
  /** A request for an SSH machine (environments.request, A57): the card takes the password through its own endpoint. */
  machine?: MachineAsk; }
/** `exists`: the owner already keeps a secret by this name; `needsValue`: the card must take a value (none, or it
 * doesn't open under this installation's key). */
export interface SecretAsk { name: string; purpose: string; exists: boolean; needsValue: boolean; }
/** The machine a Bot asks for, with the host keys scanned when it asked; `existing` when the owner already added a
 * machine at this address, so the card only grants it. */
export interface MachineAsk { name: string; host: string; port: number; user: string; directory: string | null; purpose: string;
  hostKeys: HostKeys; existing: { id: string; name: string } | null }
/** pending: the tool is waiting; ignored: the tool stopped waiting (new message, abort, stop, restart). */
export type QuestionState = "pending" | "answered" | "dismissed" | "ignored";
export interface QuestionAnswer { selected: number[]; custom: string | null; }
export interface Question extends QuestionSpec { state: QuestionState; answer: QuestionAnswer | null; settledAt: number | null; }
/** An emoji mark and who made it. */
export interface Reaction { emoji: string; memberIds: string[]; }
/** A message as a sender writes it. */
export interface MessageDraft { content: string; attachmentIds: string[]; clientMessageId?: string; /** Reply to this message (same chat). */ replyTo?: string; }
/** A partial quote as a sender asks for it: the source message and the passage (A44). */
export interface QuoteDraft { messageId: string; text: string; }

/** A chat as the asking member sees it. `botId`: a DM's Bot; null for channels and threads. */
export interface Chat {
  id: string; type: "dm" | "channel" | "thread"; botId: string | null; title: string; createdAt: number; updatedAt: number;
  lastMessage: { content: string; quotes: MessageQuote[] } | null;
  memberIds: string[]; sectionId: string | null; topic: string; parentId: string | null; rootMessageId: string | null; status: "open" | "done" | null;
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
/** A thread as listed (a channel's thread list, 「我关注的线程」): its chat, reply count and the start of its root message. */
export interface ThreadEntry extends Chat { replies: number; lastReplyAt: number | null; root: { senderId: string; content: string; quotes: MessageQuote[] } | null; }
/** A message. `role`: whether a Bot wrote it. */
export interface ChatMessage {
  id: string; chatId: string; sequence: number; senderId: string; role: "user" | "assistant";
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
  reactions: Reaction[];
  /** Partial quotes, the Nth marked `[[qN]]` in the content (A44). */
  quotes: MessageQuote[];
  /** The owner folded it to one line in the interface (A60). */
  folded: boolean;
}
/** What the search box found: chats only when searching everywhere. */
export interface SearchResult { chats: Chat[]; messages: { message: ChatMessage; chat: Chat }[] }
