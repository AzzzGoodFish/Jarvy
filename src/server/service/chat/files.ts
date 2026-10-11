import { ChatError, type ChatMessage } from "../../shared/chat.js";
import { AttachmentFiles } from "../../infra/files/attachments.js";
import type { EnvelopeMessage } from "./envelope.js";
import type { ChatService } from "./service.js";

/** Resolves authorized Chat attachments before crossing into file infrastructure. */
export class ChatFiles {
  private readonly files: AttachmentFiles;
  constructor(dataDir: string, private readonly chats: ChatService) { this.files = new AttachmentFiles(dataDir); }
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
        content: message.content, createdAt: message.createdAt, attachments: await this.paths(botId, message, signal), ...this.reply(message) });
    }
    return output;
  }
  /** The quoted message as the envelope shows it: who wrote it and its first 200 characters. */
  private reply(message: ChatMessage): Pick<EnvelopeMessage, "replyTo"> {
    const sender = message.replyTo ? this.chats.member(message.replyTo.senderId) : null;
    return message.replyTo && sender ? { replyTo: { id: message.replyTo.id, sender, text: message.replyTo.content } } : {};
  }
  async paths(actorId: string, message: ChatMessage, signal?: AbortSignal) {
    const paths: { path: string; name: string }[] = [];
    for (const item of message.attachments) {
      signal?.throwIfAborted();
      const attachment = this.chats.download(actorId, item.id);
      if (!attachment) throw new ChatError(404, "Attachment not found");
      paths.push(await this.files.materialize({ ...attachment, id: item.id, name: item.name }, signal));
    }
    return paths;
  }
  readOutgoing(workspace: string, items: readonly { path: string; name: string }[], signal?: AbortSignal) {
    return this.files.readOutgoing(workspace, items, signal);
  }
}
