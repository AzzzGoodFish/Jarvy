import { createHash } from "node:crypto";
import type { DeliveryMessage } from "../../shared/chat.js";
import type { Member } from "../../../contract/chat.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";
import type { AppendDeliveries, ChatMessages as Messages } from "./contracts.js";
import type { ChatAttachments } from "./attachments.js";

export class ChatMessages implements Messages {
  constructor(private readonly id: string, private readonly actor: string, private readonly repository: ChatRepository, private readonly attachments: ChatAttachments) {}
  async append(sender: Member, message: DeliveryMessage, deliveries: AppendDeliveries, mentions: readonly string[] = []) {
    const payload: unknown[] = message.files === undefined
      ? [this.id, message.content, message.attachmentIds]
      : [this.id, message.content, message.files.map(file => [file.name, file.sha256])];
    if (message.source) payload.push(message.source);
    if (message.question) payload.push(message.question);
    if (message.alsoToChannel) payload.push("alsoToChannel");
    if (message.replyTo) payload.push({ replyTo: message.replyTo });
    if (message.quotes?.length) payload.push({ quotes: message.quotes });
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    // A Bot's files were written aside as it sent them (A66): in place before the message row, gone again when the
    // message isn't written or was already written by an earlier try with the same key.
    const files = message.files ?? [];
    await this.attachments.commit(files);
    let saved: ReturnType<ChatRepository["append"]>;
    try { saved = this.repository.append(sender.id, this.id, message, hash, files, deliveries, mentions); }
    catch (error) { await this.attachments.discard(files.map(file => file.id)); throw error; }
    if (saved.duplicate) await this.attachments.discard(files.map(file => file.id));
    return saved;
  }
  async read(id: string) {
    const message = this.repository.message(this.actor, id);
    return message?.chatId === this.id ? message : null;
  }
  async list({ after = 0, limit }: { after?: number; limit: number }) { return this.repository.messages(this.actor, this.id, after, limit); }
  async search(query: string, { limit }: { limit: number }) { return this.repository.search(this.actor, this.id, query, limit); }
}
