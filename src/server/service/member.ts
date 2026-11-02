import type { ChatMessage } from "../shared/chat.js";
import type { MessageDraft } from "../../contract/chat.js";
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

/** A person responds in the browser, which hears of each change with the change itself: the message, mark or notice
 * comes with the chat's row, its counts and hint included (A72). So a delivery asks nothing more of it. */
export class User extends Member<MessageDraft, Promise<ChatMessage>> {
  public readonly kind = "user" as const;
  public constructor(id: string, private readonly post: (actorId: string, chatId: string, message: MessageDraft) => Promise<ChatMessage>) { super(id); }
  public deliver(): void {}
  public send(chatId: string, message: MessageDraft): Promise<ChatMessage> { return this.post(this.id, chatId, message); }
}
