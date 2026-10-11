import { isAbsolute } from "node:path";
import type { MemberIdentity } from "../../shared/chat.js";

export interface EnvelopeMessage {
  id: string;
  chat: { id: string; type: "dm" | "channel" | "thread"; title?: string; section?: string; parent?: string; root?: string; status?: string };
  sender: MemberIdentity;
  createdAt: number;
  content: string;
  /** The message this one replies to, quoted short. */
  replyTo?: { id: string; sender: MemberIdentity; text: string };
  attachments: readonly { path: string; name: string }[];
}
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u;
function escape(value: string): string {
  if (INVALID_XML.test(value)) throw new Error("Invalid XML character");
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
}
function attribute(name: string, value: string): string {
  if (!value.trim()) throw new Error(`Missing ${name}`);
  return ` ${name}="${escape(value).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;")}"`;
}
function remember(map: Map<string, string>, id: string, definition: string): void {
  const old = map.get(id);
  if (old !== undefined && old !== definition) throw new Error("Conflicting source metadata");
  map.set(id, definition);
}

/** Batch tail for channels (A37): the Bot's unread counts. */
export interface BatchDigest {
  unread: readonly { chatId: string; title: string; type: string; count: number }[];
}
const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");

/** A delivery that is not a message (A39, A41): a mark on the Bot's message, or a new notice / summary version
 * (told as where and which version, no content). */
type NoticeChat = { id: string; type: "dm" | "channel" | "thread"; title: string };
export type EnvelopeNotice =
  | { kind: "reaction"; id: number; chat: NoticeChat; message: { id: string; text: string }; actor: MemberIdentity; emoji: string; createdAt: number }
  | { kind: "note"; id: number; chat: NoticeChat; actor: MemberIdentity; version: number; createdAt: number };
/** The same compact shape as a batch, for a notice steered into a run or attached to the next one. */
export function encodeNoticeBatch(botId: string, notices: readonly EnvelopeNotice[]): string {
  if (!notices.length) throw new Error("Empty notice batch");
  const chats = new Map<string, string>(), members = new Map<string, string>();
  const list = noticeTail(notices, chats, members);
  return `<notice_batch${attribute("bot", botId)}>${[...chats.values()].join("")}${[...members.values()].join("")}${list}</notice_batch>`;
}
/** The tail shared by a steered notice batch and a chat batch (A39, A41): new notice / summary versions as
 * `<updates>` (the newest per chat), marks as `<notices>` quoting the start of the marked message. A chat already
 * described by a message keeps that (fuller) definition. */
function noticeTail(notices: readonly EnvelopeNotice[], chats: Map<string, string>, members: Map<string, string>): string {
  for (const notice of notices) {
    if (!chats.has(notice.chat.id)) chats.set(notice.chat.id, `<chat${attribute("id", notice.chat.id)}${attribute("type", notice.chat.type)}${attribute("title", notice.chat.title)}/>`);
    remember(members, notice.actor.id, `<member${attribute("id", notice.actor.id)}${attribute("name", notice.actor.name)}${attribute("kind", notice.actor.kind)}/>`);
  }
  const latest = new Map<string, Extract<EnvelopeNotice, { kind: "note" }>>();
  for (const notice of notices) if (notice.kind === "note" && (latest.get(notice.chat.id)?.version ?? 0) < notice.version) latest.set(notice.chat.id, notice);
  const updates = [...latest.values()].map(note => `<${note.chat.type === "thread" ? "summary" : "notice"}${attribute("chat", note.chat.id)}`
    + `${attribute("version", String(note.version))}${attribute("by", note.actor.id)}${attribute("at", iso(note.createdAt))}/>`);
  const marks = notices.flatMap(notice => notice.kind !== "reaction" ? [] : [`<reaction${attribute("message", notice.message.id)}${attribute("chat", notice.chat.id)}`
    + `${attribute("by", notice.actor.id)}${attribute("emoji", notice.emoji)}${attribute("at", iso(notice.createdAt))}>${escape(notice.message.text)}</reaction>`]);
  return (updates.length ? `<updates>${updates.join("")}</updates>` : "")
    + (marks.length ? `<notices>${marks.join("")}<note>这是别人对你消息的反应，按需处理，不一定要回复。</note></notices>` : "");
}

/** Compact derived input; no runtime bookkeeping, base64 or secret credentials.
 * File readability and Chat authorization are checked by the calling service.
 */
export function encodeChatBatch(botId: string, messages: readonly EnvelopeMessage[], digest?: BatchDigest, notices?: readonly EnvelopeNotice[]): string {
  if (!messages.length) throw new Error("Empty chat batch");
  const chats = new Map<string, string>(), members = new Map<string, string>(), ids = new Set<string>();
  const encoded = messages.map(message => {
    if (ids.has(message.id)) throw new Error("Duplicate message ID");
    ids.add(message.id);
    const { chat } = message;
    remember(chats, chat.id, `<chat${attribute("id", chat.id)}${attribute("type", chat.type)}${chat.title ? attribute("title", chat.title) : ""}`
      + `${chat.section ? attribute("section", chat.section) : ""}${chat.parent ? attribute("parent", chat.parent) : ""}${chat.root ? attribute("root", chat.root) : ""}${chat.status ? attribute("status", chat.status) : ""}/>`);
    remember(members, message.sender.id, `<member${attribute("id", message.sender.id)}${attribute("name", message.sender.name)}${attribute("kind", message.sender.kind)}/>`);
    const at = new Date(message.createdAt).toISOString().replace(".000Z", "Z");
    const attributes = attribute("id", message.id) + attribute("chat", message.chat.id) + attribute("from", message.sender.id) + attribute("at", at);
    const reply = message.replyTo;
    if (reply) remember(members, reply.sender.id, `<member${attribute("id", reply.sender.id)}${attribute("name", reply.sender.name)}${attribute("kind", reply.sender.kind)}/>`);
    const quote = reply ? `<reply_to${attribute("message", reply.id)}${attribute("from", reply.sender.id)}>${escape(reply.text)}</reply_to>` : "";
    const files = message.attachments.map(file => {
      if (!isAbsolute(file.path)) throw new Error("Attachment path must be absolute");
      return `<file${attribute("path", file.path)}${attribute("name", file.name)}/>`;
    }).join("");
    return `<message${attributes}>${quote}${message.content ? `<text>${escape(message.content)}</text>` : ""}${files}</message>`;
  });
  // Chats already defined in the head are referenced by ID; others carry their title and type.
  const ref = (key: string, item: { chatId: string; title: string; type: string }) => attribute(key, item.chatId) + (chats.has(item.chatId) ? "" : attribute("title", item.title) + attribute("type", item.type));
  // Deliveries that are not messages and were not steered into a run (A39, A41) ride along with the batch.
  let tail = notices?.length ? noticeTail(notices, chats, members) : "";
  if (digest?.unread.length) tail += `<unread${attribute("total", String(digest.unread.reduce((sum, item) => sum + item.count, 0)))}>`
    + `${digest.unread.map(item => `<chat${ref("id", item)}${attribute("count", String(item.count))}/>`).join("")}</unread>`;
  return `<chat_batch${attribute("bot", botId)}>${[...chats.values()].join("")}${[...members.values()].join("")}${encoded.join("")}${tail}</chat_batch>`;
}
