import type { Chat, ChatMessage, MemberIdentity } from "../../shared/chat.js";
import type { ThreadEntry } from "../../service/chat/threads.js";

// The existing DM HTTP contract keeps botId/role as presentation fields. They
// are projections of membership/author identity, not duplicated database facts.
export function chatView(chat: Chat, member: (id: string) => MemberIdentity | null) {
  return { id: chat.id, botId: chat.type === "dm" ? chat.memberIds.find(id => member(id)?.kind === "bot") ?? null : null,
    title: chat.title, type: chat.type, createdAt: chat.createdAt, updatedAt: chat.updatedAt, lastMessage: chat.lastMessage,
    memberIds: chat.memberIds, sectionId: chat.sectionId, topic: chat.topic, parentId: chat.parentId, status: chat.status,
    rootMessageId: chat.rootMessageId, note: chat.note, readSequence: chat.readSequence, unread: chat.unread, mentions: chat.mentions, following: chat.following,
    subscribed: chat.subscribed, pinned: chat.pinned, alerts: chat.alerts, hint: chat.hint, atMe: chat.atMe, muted: chat.muted, lastSender: chat.lastSender };
}
export function threadView(entry: ThreadEntry, member: (id: string) => MemberIdentity | null) {
  return { ...chatView(entry.chat, member), replies: entry.info.replies, lastReplyAt: entry.info.lastReplyAt,
    root: entry.root ? { senderId: entry.root.senderId, content: entry.root.content.slice(0, 300) } : null };
}
export function messageView(message: ChatMessage) {
  return { id: message.id, chatId: message.chatId, sequence: message.sequence, senderId: message.sender.id,
    role: message.sender.kind === "bot" ? "assistant" : "user", content: message.content,
    createdAt: message.createdAt, attachments: message.attachments, source: message.source, question: message.question, mentions: message.mentions,
    thread: message.thread, echoOf: message.echoOf, replyTo: message.replyTo, reactions: message.reactions };
}
