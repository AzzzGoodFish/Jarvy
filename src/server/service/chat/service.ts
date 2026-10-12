import type { ActivityCursor } from "../../shared/activity.js";
import { Chat } from "./chat.js";
import { ChatInfo } from "./info.js";
import { ChatMembers } from "./members.js";
import { ChatMessages } from "./messages.js";
import type { DeliveryMessage } from "../../shared/chat.js";
import { ChatError, type ChatMessage, type MessageDraft, type Chat as ChatSnapshot } from "../../shared/chat.js";
import { ChatRepository } from "../../infra/storage/chat-repository.js";
import { ChatQuestions, questionSpec } from "./questions.js";
import { ChatChannels } from "./channels.js";
import { ChatThreads } from "./threads.js";
import { Dispatcher, plan, type DeliveryHandlers } from "../delivery/delivery.js";
import { reactionTargets } from "../delivery/routes.js";

function titleValue(value: unknown): string {
  if (value === undefined) return "新对话";
  if (typeof value !== "string" || !value.trim() || value.length > 100 || value.includes("\0")) throw new ChatError(400, "Invalid Chat title");
  return value.trim();
}
export function messageDraft(input: Record<string, unknown>, hasFiles = false): MessageDraft {
  if (typeof input.content !== "string" || input.content.length > 32_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(input.content))
    throw new ChatError(400, "Invalid message");
  const ids = input.attachmentIds ?? [];
  if (!Array.isArray(ids) || ids.length > 5 || new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === "string" && /^[a-f\d-]{36}$/.test(id))) throw new ChatError(400, "Invalid attachments");
  if (!input.content.trim() && !ids.length && !hasFiles) throw new ChatError(400, "Message or attachment required");
  const key = input.clientMessageId;
  if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 128 || key.includes("\0")))
    throw new ChatError(400, "Invalid message key");
  // Actor identity never comes from a message body, even when it names a valid member.
  if ("senderId" in input || "sender" in input || "role" in input || "source" in input || "historyId" in input || "toolCallId" in input) throw new ChatError(400, "Message author is bound by the server");
  const replyTo = input.replyTo;
  if (replyTo !== undefined && replyTo !== null && (typeof replyTo !== "string" || !/^m\d+$/.test(replyTo))) throw new ChatError(400, "Invalid replyTo");
  return { content: input.content, attachmentIds: ids, ...(key === undefined ? {} : { clientMessageId: key as string }), ...(typeof replyTo === "string" ? { replyTo } : {}) };
}
/** One emoji (a single grapheme with a pictograph, keycap or flag), as people and Bots mark messages with. */
export function emojiValue(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 32) throw new ChatError(400, "Invalid emoji");
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  if (graphemes.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) throw new ChatError(400, "Invalid emoji");
  return value;
}
export interface ChatNotifications {
  /** A committed delivery reached a Bot (A41); the Bot decides how to respond to its urgency. */
  bot?: DeliveryHandlers["bot"];
  /** … or a person. */
  user?: DeliveryHandlers["user"];
  saved?: (chatId: string) => void;
  /** An owner's channel groups changed (a Bot may create or rename them). */
  sections?: (ownerId: string) => void;
}

export class ChatService {
  readonly questions: ChatQuestions;
  readonly channels: ChatChannels;
  readonly threads: ChatThreads;
  private readonly dispatcher: Dispatcher;
  constructor(private readonly repository: ChatRepository, private readonly notifications: ChatNotifications = {}) {
    this.dispatcher = new Dispatcher({ bot: notifications.bot, user: notifications.user });
    this.threads = new ChatThreads(repository, chatId => this.notifySaved(chatId));
    this.questions = new ChatQuestions(repository, chatId => this.notifySaved(chatId));
    this.channels = new ChatChannels(repository, chatId => this.notifySaved(chatId), ownerId => {
      try { this.notifications.sections?.(ownerId); } catch { console.error("[chat] section notification failed"); }
    }, deliveries => this.dispatcher.dispatch(deliveries));
  }
  list(actorId: string) { return this.repository.listChats(actorId); }
  get(actorId: string, chatId: string) { return this.repository.getChat(actorId, chatId); }
  sentActivity(actorId: string, senderId: string, before: ActivityCursor | undefined, limit: number) {
    return this.repository.sentActivity(actorId, senderId, before, limit);
  }
  member(id: string) { return this.repository.member(id); }
  createDm(actorId: string, input: Record<string, unknown>) {
    if (input.botId !== undefined && typeof input.botId !== "string") throw new ChatError(400, "Invalid Bot ID");
    return this.repository.createDm(actorId, input.botId as string | undefined, titleValue(input.title));
  }
  /** A DM with another member of the actor's space (a Bot DMs its owner or another Bot); one per pair. */
  openDirect(actorId: string, targetId: string): ChatSnapshot {
    const owner = this.repository.channels.ownerOf(actorId), directory = this.repository.channels.directory(owner);
    const actor = directory.find(member => member.id === actorId), target = directory.find(member => member.id === targetId);
    if (!actor || !target) throw new ChatError(404, "Member not found");
    const chat = this.repository.openDirect(actorId, targetId, owner, `${actor.name}、${target.name}`);
    this.notifySaved(chat.id);
    return chat;
  }
  /** A Bot's DMs with other Bots, for its owner (read-only). */
  botDirects(ownerId: string, botId: string): ChatSnapshot[] {
    if (this.repository.channels.ownerOf(botId) !== ownerId || botId === ownerId) throw new ChatError(404, "Bot not found");
    return this.repository.botDirects(ownerId, botId);
  }
  /** Channels and threads a Bot subscribed to, for its owner. */
  subscriptions(ownerId: string, botId: string): ChatSnapshot[] {
    if (this.repository.channels.ownerOf(botId) !== ownerId || botId === ownerId) throw new ChatError(404, "Bot not found");
    return this.repository.channels.subscriptions(botId).map(id => this.repository.getChat(ownerId, id)).filter(chat => chat !== null);
  }
  subscribe(actorId: string, chatId: string, subscribed: unknown): ChatSnapshot {
    if (typeof subscribed !== "boolean") throw new ChatError(400, "Invalid subscribed");
    this.repository.channels.setSubscribed(actorId, chatId, subscribed);
    this.notifySaved(chatId);
    return this.repository.getChat(actorId, chatId)!;
  }
  /** Notices waiting for a Bot (A39). */
  notices(botId: string) { return this.channels.notices(botId); }
  tellNotices(botId: string, ids: readonly number[]) { this.channels.tellNotices(botId, ids); }
  /** Marks a message with an emoji, or removes the actor's mark. Its author is told (A39), as
   * routed and graded by `service/delivery` (A41). Returns the message as it is now.
   * Called with `on` for a mark the actor already has, the mark is taken off instead (the caller says so in the result). */
  /** Whether this member already has this emoji on this message (used by `messages.react` to report a toggle). */
  reactionOn(actorId: string, messageId: string, emoji: unknown): boolean {
    return this.repository.interactions.reactionOn(actorId, messageId, emojiValue(emoji));
  }
  react(actorId: string, messageId: string, emoji: unknown, on: unknown): ChatMessage {
    if (typeof on !== "boolean") throw new ChatError(400, "Invalid reaction state");
    const marked = this.repository.message(actorId, messageId);
    if (!marked) throw new ChatError(404, "Message not found");
    const value = emojiValue(emoji), toggled = this.repository.interactions.reactionOn(actorId, messageId, value);
    const apply = on === toggled ? !on : on;
    // The author is told only while it can still read the chat (a deleted Bot cannot).
    const author = this.repository.canAccess(marked.sender.id, marked.chatId) ? marked.sender : undefined;
    const deliveries = apply ? plan("reaction", reactionTargets({ actorId, author })) : [];
    const { chatId, added } = this.repository.interactions.react(actorId, messageId, value, apply, deliveries);
    this.notifySaved(chatId);
    if (added) this.dispatcher.dispatch(deliveries);
    return this.repository.message(actorId, messageId)!;
  }
  mute(actorId: string, chatId: string, muted: unknown): ChatSnapshot {
    if (typeof muted !== "boolean") throw new ChatError(400, "Invalid muted");
    this.repository.interactions.setMuted(actorId, chatId, muted);
    return this.repository.getChat(actorId, chatId)!;
  }
  pin(actorId: string, chatId: string, pinned: unknown): ChatSnapshot {
    if (typeof pinned !== "boolean") throw new ChatError(400, "Invalid pinned");
    this.repository.interactions.setPinned(actorId, chatId, pinned);
    return this.repository.getChat(actorId, chatId)!;
  }
  /** The message with up to `context` messages before and after it (read position unchanged). */
  around(actorId: string, messageId: string, context: number) {
    const message = this.repository.message(actorId, messageId);
    if (!message) throw new ChatError(404, "Message not found");
    return [...this.repository.messagesBefore(actorId, message.chatId, message.sequence, context), message,
      ...this.repository.messages(actorId, message.chatId, message.sequence, context)];
  }
  /** Exactly the unread messages of a chat, oldest first; the caller moves the read position. */
  unreadMessages(actorId: string, chatId: string, limit: number) { return this.repository.unreadMessages(actorId, chatId, limit); }
  searchAll(actorId: string, query: string, limit = 30) {
    if (!query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ChatError(400, "Invalid search query or limit");
    return this.repository.searchAll(actorId, query, limit);
  }
  /** The newest `limit` messages before a sequence (null: the newest of all), oldest first, for scrolling back. */
  readBefore(actorId: string, chatId: string, before: number | null, limit: number) {
    if ((before !== null && (!Number.isSafeInteger(before) || before < 1)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new ChatError(400, "Invalid message cursor or limit");
    const messages = this.repository.messagesBefore(actorId, chatId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    return { messages: messages.slice(-limit), hasOlder: messages.length > limit };
  }
  read(actorId: string, chatId: string, after = 0, limit = 1000) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new ChatError(400, "Invalid message cursor or limit");
    return this.repository.messages(actorId, chatId, after, limit);
  }
  instance(actorId: string, chatId: string): Chat {
    this.repository.assertAccess(actorId, chatId);
    // A thread reply also changes its channel (reply count under the root, or the 「同时发到频道」 copy).
    const parentId = this.repository.getChat(actorId, chatId)?.parentId ?? null;
    return new Chat(chatId, {
      info: new ChatInfo(chatId, actorId, this.repository),
      members: new ChatMembers(chatId, actorId, this.repository, (message, deliveries) => {
        this.notifySaved(chatId);
        if (parentId) this.notifySaved(parentId);
        this.dispatcher.dispatch(deliveries, message);
      }),
      messages: new ChatMessages(chatId, actorId, this.repository),
    }, { delete: async id => { this.repository.assertOwner(actorId, id); this.repository.deleteChat(actorId, id); } });
  }
  async send(actorId: string, chatId: string, input: Record<string, unknown>): Promise<ChatMessage> {
    if (input.alsoToChannel !== undefined && typeof input.alsoToChannel !== "boolean") throw new ChatError(400, "Invalid alsoToChannel");
    return this.deliver(actorId, chatId, { ...messageDraft(input), alsoToChannel: input.alsoToChannel === true });
  }
  async deliver(actorId: string, chatId: string, message: DeliveryMessage): Promise<ChatMessage> {
    const files = message.files ?? [];
    if (files.length > 5) throw new ChatError(400, "Too many attachments");
    for (const file of files) {
      if (!file.name.trim() || file.name.length > 200 || /[\x00-\x1f\x7f\\/]/.test(file.name) || [".", ".."].includes(file.name) || !file.data.length || file.data.length > 10 * 1024 * 1024)
        throw new ChatError(400, "Invalid attachment");
    }
    const draft = messageDraft({ content: message.content, attachmentIds: message.attachmentIds, clientMessageId: message.clientMessageId, replyTo: message.replyTo }, files.length > 0);
    const question = message.question ? questionSpec(message.question as unknown as Record<string, unknown>) : undefined;
    return this.instance(actorId, chatId).deliver(actorId, { ...draft, files: message.files, source: message.source, ...(question ? { question } : {}),
      ...(message.alsoToChannel ? { alsoToChannel: true } : {}) });
  }
  message(actorId: string, id: string) { return this.repository.message(actorId, id); }
  search(actorId: string, chatId: string, query: string, limit = 30) {
    if (!query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ChatError(400, "Invalid search query or limit");
    return this.repository.search(actorId, chatId, query, limit);
  }
  private notifySaved(chatId: string): void {
    try { this.notifications.saved?.(chatId); }
    catch { console.error("[chat] committed-message notification failed", { chatId }); }
  }
  upload(actorId: string, chatId: string, rawName: unknown, mimeType: string, data: Buffer) {
    if (typeof rawName !== "string" || !rawName.trim() || rawName.length > 200 || /[\x00-\x1f\x7f\\/]/.test(rawName) || [".", ".."].includes(rawName.trim()))
      throw new ChatError(400, "Invalid filename");
    if (typeof mimeType !== "string" || mimeType.length > 100 || !data.length || data.length > 10 * 1024 * 1024) throw new ChatError(400, "Invalid attachment");
    return this.repository.createAttachment(actorId, chatId, rawName.trim(), mimeType, data);
  }
  download(actorId: string, id: string) { return this.repository.attachment(actorId, id); }
  removePendingAttachment(actorId: string, id: string) { return this.repository.removePendingAttachment(actorId, id); }
  async delete(actorId: string, chatId: string): Promise<boolean> {
    const chat = this.repository.getChat(actorId, chatId);
    if (!chat || chat.ownerId !== actorId) return false;
    await this.instance(actorId, chatId).delete();
    return true;
  }
}
