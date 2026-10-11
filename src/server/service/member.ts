import type { ChatMessage, MessageDraft } from "../shared/chat.js";
import type { Urgency } from "../shared/delivery.js";

/** Shared identity and communication contract; concrete members own their behaviour. People and Bots get the
 * same deliveries (A41); how to respond to one is each member's own business. */
export abstract class Member<Output, Result> {
  public abstract readonly kind: "user" | "bot";
  public constructor(public readonly id: string) {}
  /** Something was delivered to this member, durably, with this urgency. */
  public abstract deliver(urgency: Urgency): void | Promise<void>;
  public abstract send(chatId: string, message: Output): Result;
}

/** A person responds in the browser: a chat changed (refresh it), or the inbox did (show it). */
export class User extends Member<MessageDraft, Promise<ChatMessage>> {
  public readonly kind = "user" as const;
  public constructor(id: string, private readonly post: (actorId: string, chatId: string, message: MessageDraft) => Promise<ChatMessage>,
    private readonly chatChanged: (chatId: string) => void, private readonly inboxChanged: (urgency: Urgency) => void = () => {}) { super(id); }
  public deliver(urgency: Urgency): void { this.inboxChanged(urgency); }
  /** A chat this person can see was saved. */
  public changed(chatId: string): void { this.chatChanged(chatId); }
  public send(chatId: string, message: MessageDraft): Promise<ChatMessage> { return this.post(this.id, chatId, message); }
}
