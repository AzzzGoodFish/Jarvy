import { ChatError, type Chat, type ChatMessage, type MemberIdentity } from "../../shared/chat.js";
import type { ChatService } from "../chat/service.js";
import { listing, type ChatFiles } from "../chat/files.js";
import { messageRow, threadRow } from "./chat-views.js";

type Scope = { botId: string; chats: ChatService; files: ChatFiles };
const same = (a: string, b: string) => a.trim().replace(/^@/, "").toLocaleLowerCase() === b.toLocaleLowerCase();

/** The chat gateway's structure and reading tools: members, channels, sections, threads,
 * subscriptions, reading and search. Sending and asking stay in Tools, which owns the runtime's send. */
export class ChatTools {
  constructor(private readonly scope: Scope) {}
  private get chats() { return this.scope.chats; }
  private get bot() { return this.scope.botId; }

  chat(chatId: string): Chat {
    const chat = this.chats.get(this.bot, chatId);
    if (!chat) throw new ChatError(404, "Chat not found");
    return chat;
  }
  /** Members by name (case-insensitive, a leading @ allowed); unknown names are an error that lists them. */
  members(names: readonly string[]): MemberIdentity[] {
    const directory = this.chats.channels.directory(this.bot);
    const found = names.map(name => ({ name, member: directory.find(member => same(name, member.name)) }));
    const missing = found.filter(item => !item.member).map(item => item.name);
    if (missing.length) throw new ChatError(404, `No member named: ${missing.join(", ")} (see members.list)`);
    return found.map(item => item.member!);
  }
  /** A channel group by ID or name. */
  section(value: string): string {
    const sections = this.chats.channels.sections(this.bot);
    const matches = sections.filter(section => section.id === value || same(value, section.name));
    if (!matches.length) throw new ChatError(404, `No section named ${value} (see sections.list)`);
    if (matches.length > 1) throw new ChatError(409, `Several sections are named ${value}; use one of: ${matches.map(section => section.id).join(", ")}`);
    return matches[0]!.id;
  }

  membersList() {
    return this.chats.channels.profiles(this.bot).map(member => ({ name: member.name, kind: member.kind,
      ...(member.description ? { description: member.description } : {}), ...(member.id === this.bot ? { self: true } : {}) }));
  }
  create(input: { name: string; topic?: string; section?: string; members?: string[] }) {
    const members = this.members(input.members ?? []);
    const id = this.chats.channels.createChannel(this.bot, { name: input.name, topic: input.topic, sectionId: input.section ? this.section(input.section) : null,
      memberIds: members.map(member => member.id) });
    const chat = this.chat(id);
    return { chatId: id, name: chat.title, members: chat.memberIds.map(memberId => this.chats.member(memberId)?.name) };
  }
  update(input: { chatId: string; name?: string; topic?: string; section?: string; notice?: string; title?: string; status?: "open" | "done" }) {
    const chat = this.chat(input.chatId);
    const channelChange = input.name !== undefined || input.topic !== undefined || input.section !== undefined;
    const threadChange = input.title !== undefined || input.status !== undefined;
    if (!channelChange && !threadChange && input.notice === undefined) throw new ChatError(400, "Nothing to update");
    if (channelChange && chat.type !== "channel") throw new ChatError(400, "Only channels have a name, topic and section");
    if (threadChange && chat.type !== "thread") throw new ChatError(400, "Only threads have a title and status");
    if (channelChange) this.chats.channels.updateChannel(this.bot, chat.id, { name: input.name, topic: input.topic,
      sectionId: input.section === undefined ? undefined : input.section === "" ? null : this.section(input.section) });
    if (threadChange) this.chats.threads.update(this.bot, chat.id, { title: input.title, status: input.status });
    const note = input.notice === undefined ? null : this.chats.channels.setNote(this.bot, chat.id, input.notice);
    const updated = this.chat(chat.id);
    const section = updated.sectionId ? this.chats.channels.sections(this.bot).find(item => item.id === updated.sectionId)?.name : undefined;
    return { chatId: chat.id, title: updated.title, ...(updated.type === "channel" ? { topic: updated.topic, section: section ?? null } : {}),
      ...(updated.type === "thread" ? { status: updated.status } : {}), ...(note ? { noticeVersion: note.version } : {}) };
  }
  addMembers(input: { chatId: string; members: string[] }) {
    const chat = this.chat(input.chatId), members = this.members(input.members);
    if (chat.type !== "channel") throw new ChatError(400, "Members are added to channels");
    const added: string[] = [], already: string[] = [];
    for (const member of members) {
      if (chat.memberIds.includes(member.id) || added.includes(member.name)) { already.push(member.name); continue; }
      this.chats.channels.addMember(this.bot, chat.id, member.id);
      added.push(member.name);
    }
    return { chatId: chat.id, added, ...(already.length ? { already } : {}) };
  }
  subscribe(input: { chatId: string; subscribed: boolean }) {
    const chat = this.chats.subscribe(this.bot, this.chat(input.chatId).id, input.subscribed);
    return { chatId: chat.id, type: chat.type, subscribed: chat.subscribed, ...(chat.type === "thread" ? { following: chat.following } : {}) };
  }
  threads(input: { chatId: string; status?: "open" | "done" | "all" }) {
    const status = input.status ?? "open";
    if (this.chat(input.chatId).type !== "channel") throw new ChatError(400, "Threads belong to channels");
    return this.chats.threads.list(this.bot, input.chatId).filter(entry => status === "all" || entry.chat.status === status)
      .map(entry => threadRow(this.chats, entry));
  }
  follow(input: { chatId: string; following: boolean }) {
    const chat = this.chats.threads.setFollowing(this.bot, input.chatId, input.following);
    return { chatId: chat.id, following: chat.following };
  }
  sections() { return this.chats.channels.sections(this.bot).map(section => ({ id: section.id, name: section.name })); }
  createSection(input: { name: string }) {
    const section = this.chats.channels.createSection(this.bot, { name: input.name });
    return { id: section.id, name: section.name };
  }
  updateSection(input: { section: string; name: string }) {
    const section = this.chats.channels.updateSection(this.bot, this.section(input.section), { name: input.name });
    return { id: section.id, name: section.name };
  }

  async read(input: { chatId?: string; after?: number; around?: string; context?: number; unread?: boolean; limit?: number }, signal?: AbortSignal) {
    const limit = input.limit ?? 30, modes = [input.after !== undefined, input.around !== undefined, input.unread === true].filter(Boolean).length;
    if (modes > 1) throw new ChatError(400, "Use one of after, around or unread");
    if (input.around !== undefined) {
      const messages = this.chats.around(this.bot, input.around, input.context ?? 5);
      if (input.chatId !== undefined && messages[0]?.chatId !== input.chatId) throw new ChatError(404, "Message not found in this chat");
      return { chatId: messages[0]!.chatId, messages: await this.rows(messages, signal) };
    }
    if (input.unread && input.chatId === undefined) {
      const chats = [];
      for (const chat of [...this.chats.list(this.bot), ...this.chats.threads.followed(this.bot).map(entry => entry.chat)].filter(item => item.unread > 0))
        chats.push({ chatId: chat.id, type: chat.type, title: chat.title, ...await this.page(chat.id, this.chats.unreadMessages(this.bot, chat.id, limit + 1), limit, signal) });
      return { chats };
    }
    if (input.chatId === undefined) throw new ChatError(400, "chatId is required unless unread=true");
    const chat = this.chat(input.chatId);
    const messages = input.unread ? this.chats.unreadMessages(this.bot, chat.id, limit + 1) : this.chats.read(this.bot, chat.id, input.after ?? 0, limit + 1);
    return { chatId: chat.id, ...await this.page(chat.id, messages, limit, signal) };
  }
  /** One page of a sequential read; the read position moves to its last message. */
  private async page(chatId: string, messages: ChatMessage[], limit: number, signal?: AbortSignal) {
    const page = messages.slice(0, limit);
    if (page.length) this.chats.channels.markRead(this.bot, chatId, page.at(-1)!.sequence);
    return { messages: await this.rows(page, signal), ...(messages.length > limit ? { hasMore: true } : {}) };
  }
  private async rows(messages: readonly ChatMessage[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    return messages.map(message => messageRow(this.chats, this.bot, message, listing(message)));
  }
  /** `mine`: only what this Bot sent; those messages carry the History ID of the turn that sent them (A21). */
  search(input: { chatId?: string; query: string; limit?: number; mine?: boolean }) {
    const sender = input.mine ? this.bot : undefined;
    const found = input.chatId === undefined ? this.chats.searchAll(this.bot, input.query, input.limit ?? 30, undefined, sender)
      : this.chats.search(this.bot, this.chat(input.chatId).id, input.query, input.limit ?? 30, sender);
    const chats = new Map<string, Chat | null>();
    const chatOf = (id: string) => { if (!chats.has(id)) chats.set(id, this.chats.get(this.bot, id)); return chats.get(id); };
    return found.map(message => messageRow(this.chats, this.bot, message, listing(message), input.chatId === undefined ? chatOf(message.chatId) : null));
  }
}
