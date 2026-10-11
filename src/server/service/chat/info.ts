import { ChatError } from "../../shared/chat.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";
import type { ChatInfo as Info } from "./contracts.js";

export class ChatInfo implements Info {
  constructor(private readonly id: string, private readonly actor: string, private readonly repository: ChatRepository) {}
  snapshot() {
    const chat = this.repository.getChat(this.actor, this.id);
    if (!chat) throw new ChatError(404, "Chat not found");
    const { title, type, ownerId, createdAt, updatedAt } = chat;
    return { title, type, ownerId, createdAt, updatedAt };
  }
  async update(input: { title: string }) {
    if (!input.title.trim() || input.title.length > 100) throw new ChatError(400, "Invalid Chat title");
    this.repository.updateTitle(this.actor, this.id, input.title.trim());
  }
}
