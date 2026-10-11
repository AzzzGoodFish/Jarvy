import { ChatError, type ChatMessage } from "../../shared/chat.js";
import type { Delivery } from "../../shared/delivery.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";
import type { ChatMembers as Members, ChatMembership } from "./contracts.js";

type NotifyMembers = (message: ChatMessage, deliveries: readonly Delivery[]) => void;

export class ChatMembers implements Members {
  constructor(private readonly id: string, private readonly actor: string, private readonly repository: ChatRepository, private readonly onNotify: NotifyMembers) {}
  async list() { return this.repository.memberships(this.actor, this.id); }
  async get(id: string) { return (await this.list()).find(m => m.member.id === id) ?? null; }
  async add(m: ChatMembership) { this.repository.addMember(this.actor, this.id, m.member.id, m.canRead, m.canWrite); }
  async remove(id: string) { this.repository.removeMember(this.actor, this.id, id); }
  async requireSender(id: string) {
    if (id !== this.actor) throw new ChatError(403, "Sender does not match caller");
    this.repository.assertAccess(id, this.id, true);
    return this.repository.member(id)!;
  }
  async subscribers() { return this.repository.channels.subscribers(this.id); }
  async muted() { return this.repository.interactions.mutedIn(this.id); }
  async channelAudience() {
    const parentId = this.repository.getChat(this.actor, this.id)?.parentId;
    if (!parentId) return null;
    return { members: this.repository.memberships(this.actor, parentId).filter(item => item.canRead).map(item => item.member),
      subscribers: this.repository.channels.subscribers(parentId), muted: this.repository.interactions.mutedIn(parentId) };
  }
  notify(message: ChatMessage, deliveries: readonly Delivery[]) { this.onNotify(message, deliveries); }
}
