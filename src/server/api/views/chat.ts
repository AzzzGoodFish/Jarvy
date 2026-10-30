import type { Chat, ChatMessage } from "../../shared/chat.js";
import type { Chat as ChatView, ChatMessage as MessageView, Member, ThreadEntry as ThreadView } from "../../../contract/chat.js";
import { clipMarked } from "../../shared/quotes.js";
import type { ThreadEntry } from "../../service/chat/threads.js";
import type { ThreadItem } from "../../../contract/threads.js";

// The existing DM HTTP contract keeps botId/role as presentation fields. They
// are projections of membership/author identity, not duplicated database facts.
export function chatView(chat: Chat, member: (id: string) => Member | null): ChatView {
  return { id: chat.id, botId: chat.type === "dm" ? chat.memberIds.find(id => member(id)?.kind === "bot") ?? null : null,
    title: chat.title, type: chat.type, createdAt: chat.createdAt, updatedAt: chat.updatedAt, lastMessage: chat.lastMessage,
    memberIds: chat.memberIds, sectionId: chat.sectionId, topic: chat.topic, parentId: chat.parentId, status: chat.status,
    rootMessageId: chat.rootMessageId, note: chat.note, readSequence: chat.readSequence, unread: chat.unread, mentions: chat.mentions, following: chat.following,
    subscribed: chat.subscribed, pinned: chat.pinned, alerts: chat.alerts, hint: chat.hint, atMe: chat.atMe, muted: chat.muted, lastSender: chat.lastSender };
}
export function threadView(entry: ThreadEntry, member: (id: string) => Member | null): ThreadView {
  return { ...chatView(entry.chat, member), replies: entry.info.replies, lastReplyAt: entry.info.lastReplyAt,
    root: entry.root ? { senderId: entry.root.senderId, content: clipMarked(entry.root.content, 300), quotes: entry.root.quotes } : null };
}
/** A row of 「我关注的线程」 (A69): only what the row shows; the thread's pane loads the chat itself. */
export function threadItemView({ chat, info, root }: ThreadEntry): ThreadItem {
  return { id: chat.id, title: chat.title, status: chat.status ?? "open", parentId: chat.parentId!, createdAt: chat.createdAt,
    replies: info.replies, lastReplyAt: info.lastReplyAt, root: root ? { senderId: root.senderId, content: clipMarked(root.content, 300), quotes: root.quotes } : null,
    unread: chat.unread, mentions: chat.mentions, alerts: chat.alerts, following: chat.following };
}
export function messageView(message: ChatMessage): MessageView {
  return { id: message.id, chatId: message.chatId, sequence: message.sequence, senderId: message.sender.id,
    role: message.sender.kind === "bot" ? "assistant" : "user", content: message.content,
    createdAt: message.createdAt, attachments: message.attachments, source: message.source, question: message.question, mentions: message.mentions,
    thread: message.thread, echoOf: message.echoOf, replyTo: message.replyTo, reactions: message.reactions, quotes: message.quotes, folded: message.folded };
}
