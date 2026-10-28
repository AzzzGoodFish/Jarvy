import type { Chat, ChatMessage } from "../../shared/chat.js";
import { expandQuotes, previewQuotes, replyExcerpt } from "../../shared/quotes.js";
import type { ChatService } from "../chat/service.js";
import type { ThreadEntry } from "../chat/threads.js";

const iso = (time: number) => new Date(time).toISOString();
/** Quotes are expanded wherever a Bot reads a message (A44). */
const name = (chats: ChatService) => (memberId: string) => chats.member(memberId)?.name ?? memberId;

/** What a Bot sees of its chats through the chat gateway (A37): compact rows and a detail view. Threads appear
 * when the Bot follows them. */
export function chatRows(chats: ChatService, botId: string) {
  const sections = new Map(chats.channels.sections(botId).map(section => [section.id, section.name]));
  const row = (chat: Chat) => ({ id: chat.id, type: chat.type, title: chat.title,
    ...(chat.type === "dm" ? { with: chat.memberIds.filter(id => id !== botId).map(id => chats.member(id)?.name).filter(Boolean) } : {}),
    ...(chat.sectionId ? { section: sections.get(chat.sectionId) } : {}), ...(chat.topic ? { topic: chat.topic } : {}),
    ...(chat.type === "thread" ? { parent: chat.parentId, status: chat.status } : {}),
    unread: chat.unread, ...(chat.mentions && chat.type !== "dm" ? { mentions: chat.mentions } : {}), ...(chat.subscribed ? { subscribed: true } : {}),
    ...(chat.note ? { noticeVersion: chat.note.version } : {}), updatedAt: iso(chat.updatedAt) });
  return [...chats.list(botId).map(row), ...chats.threads.followed(botId).map(entry => row(entry.chat))];
}
/** Members, topic and the full notice (a thread: title, status, parent, root message and summary); reading it
 * counts as having seen this version. A thread's also carries its channel's notice, which a send there needs (A67). */
export function chatDetail(chats: ChatService, botId: string, chat: Chat) {
  const section = chat.sectionId ? chats.channels.sections(botId).find(item => item.id === chat.sectionId)?.name : undefined;
  const members = chat.memberIds.map(id => chats.member(id)).filter(member => member !== null).map(member => ({ id: member.id, name: member.name, kind: member.kind }));
  if (chat.note) chats.channels.noteSeen(botId, chat.id, chat.note.version);
  const parent = chat.type === "thread" && chat.parentId ? chats.get(botId, chat.parentId) : null;
  if (parent?.note) chats.channels.noteSeen(botId, parent.id, parent.note.version);
  const root = chat.type === "thread" && chat.rootMessageId ? chats.message(botId, chat.rootMessageId) : null;
  return { id: chat.id, type: chat.type, title: chat.title, ...(section ? { section } : {}), ...(chat.topic ? { topic: chat.topic } : {}),
    ...(chat.type === "thread" ? { parent: chat.parentId, status: chat.status, following: chat.following,
      root: root ? { id: root.id, from: root.sender.name, content: expandQuotes(root.content, root.quotes, name(chats)), at: iso(root.createdAt) } : null } : {}),
    members,
    notice: chat.note ? { text: chat.note.text, version: chat.note.version, by: chat.note.updatedBy.name, at: iso(chat.note.updatedAt) } : null,
    // A send in a thread needs this too, so it comes here rather than in a second call (A67).
    ...(parent?.note ? { parentNotice: { chatId: parent.id, title: parent.title, text: parent.note.text, version: parent.note.version,
      by: parent.note.updatedBy.name, at: iso(parent.note.updatedAt) } } : {}),
    unread: chat.unread, readSequence: chat.readSequence, ...(chat.type !== "dm" ? { subscribed: chat.subscribed } : {}) };
}
/** A thread in threads.list. */
export function threadRow(chats: ChatService, entry: ThreadEntry) {
  return { id: entry.chat.id, title: entry.chat.title, status: entry.chat.status, replies: entry.info.replies,
    ...(entry.info.lastReplyAt ? { lastReplyAt: iso(entry.info.lastReplyAt) } : {}),
    root: entry.root ? { id: entry.chat.rootMessageId, from: chats.member(entry.root.senderId)?.name ?? entry.root.senderId, preview: previewQuotes(entry.root.content, entry.root.quotes).slice(0, 200) } : null,
    following: entry.chat.following, subscribed: entry.chat.subscribed, unread: entry.chat.unread };
}
/** A message as a Bot reads it: names instead of member IDs, the thread folded to title / status / replies, and
 * the History ID only on its own messages (that is the History it can read). */
export function messageRow(chats: ChatService, botId: string, message: ChatMessage, attachments: readonly unknown[], chat?: Chat | null) {
  const question = message.question;
  return { id: message.id, seq: message.sequence,
    ...(chat ? { chat: { id: chat.id, type: chat.type, title: chat.title } } : {}),
    from: message.sender.name, at: iso(message.createdAt), text: expandQuotes(message.content, message.quotes, name(chats)),
    ...(attachments.length ? { attachments } : {}),
    ...(message.mentions.length ? { mentions: message.mentions.map(id => chats.member(id)?.name ?? id) } : {}),
    ...(message.thread ? { thread: { id: message.thread.id, title: message.thread.title, status: message.thread.status, replies: message.thread.replies } } : {}),
    ...(message.echoOf ? { fromThread: message.echoOf } : {}),
    ...(message.replyTo ? { replyTo: { id: message.replyTo.id, from: chats.member(message.replyTo.senderId)?.name ?? message.replyTo.senderId, text: replyExcerpt(message.replyTo) } } : {}),
    ...(message.reactions.length ? { reactions: message.reactions.map(group => ({ emoji: group.emoji,
      by: group.memberIds.map(id => chats.member(id)?.name ?? id) })) } : {}),
    ...(question ? { question: { options: question.options.map(option => option.label), state: question.state,
      ...(question.answer ? { selected: question.answer.selected.map(index => question.options[index]?.label), ...(question.answer.custom ? { custom: question.answer.custom } : {}) } : {}) } } : {}),
    ...(message.source && message.sender.id === botId ? { historyId: message.source.historyId } : {}) };
}
