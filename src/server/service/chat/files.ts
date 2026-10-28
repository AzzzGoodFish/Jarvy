import { ChatError, type ChatMessage } from "../../shared/chat.js";
import { type Attachment } from "../../../contract/chat.js";
import { expandQuotes, replyExcerpt } from "../../shared/quotes.js";
import type { EnvelopeMessage, FileListing } from "./envelope.js";
import type { ChatService } from "./service.js";

/** Files in messages as Bots see them (A50): listed by id, name, type and size, and opened only through the backend,
 * for messages the Bot can read. No path on any machine is handed out. */
export class ChatFiles {
  constructor(private readonly chats: ChatService) {}
  async envelope(botId: string, messageIds: readonly string[], signal?: AbortSignal): Promise<EnvelopeMessage[]> {
    const output: EnvelopeMessage[] = [];
    for (const id of messageIds) {
      signal?.throwIfAborted();
      const message = this.chats.message(botId, id);
      if (!message) throw new ChatError(404, "Message not found");
      const chat = this.chats.get(botId, message.chatId);
      if (!chat) throw new ChatError(404, "Chat not found");
      const section = chat.sectionId ? this.chats.channels.sections(botId).find(item => item.id === chat.sectionId)?.name : undefined;
      output.push({ id, chat: { id: chat.id, type: chat.type, title: chat.title, ...(section ? { section } : {}),
        ...(chat.parentId ? { parent: chat.parentId } : {}), ...(chat.rootMessageId ? { root: chat.rootMessageId } : {}), ...(chat.status ? { status: chat.status } : {}) }, sender: message.sender,
        content: expandQuotes(message.content, message.quotes, memberId => this.chats.member(memberId)?.name ?? memberId), createdAt: message.createdAt,
        attachments: listing(message), ...this.reply(message) });
    }
    return output;
  }
  /** The quoted message as the envelope shows it: who wrote it and its first 200 characters. */
  private reply(message: ChatMessage): Pick<EnvelopeMessage, "replyTo"> {
    const sender = message.replyTo ? this.chats.member(message.replyTo.senderId) : null;
    return message.replyTo && sender ? { replyTo: { id: message.replyTo.id, sender, text: replyExcerpt(message.replyTo) } } : {};
  }
  /** A file of a message the actor can read. */
  open(actorId: string, attachmentId: string): Attachment {
    const found = this.chats.attachments.find(actorId, attachmentId);
    if (!found) throw new ChatError(404, "File not found, or in a message you can't read");
    return found;
  }
  /** Its contents in pieces, for a copy into a Bot's environment. */
  chunks(file: Attachment): AsyncIterable<Uint8Array> { return this.chats.attachments.stream(file); }
  head(file: Attachment, bytes: number): Promise<Buffer> { return this.chats.attachments.head(file, bytes); }
  read(file: Attachment, limit: number): Promise<Buffer> { return this.chats.attachments.read(file, limit); }
}

/** A message's files as a Bot reads them. */
export function listing(message: ChatMessage): FileListing[] {
  return message.attachments.map(file => ({ id: file.id, name: file.name, type: file.mimeType || "application/octet-stream", size: byteSize(file.size) }));
}
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
