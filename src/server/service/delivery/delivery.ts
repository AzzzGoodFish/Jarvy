import type { ChatMessage } from "../../shared/chat.js";
import type { Member } from "../../../contract/chat.js";
import type { Delivery, DeliveryKind, DeliveryPayloads, DeliveryReason, DeliveryTarget, SystemKind, Urgency } from "../../shared/delivery.js";
import { mutedUrgency, urgencyOf } from "./policy.js";

/** Turns a route's targets into deliveries (the policy decides the urgency), and hands committed deliveries to
 * the recipient side (A41). It knows neither Pi nor the UI: each kind of recipient registers how it responds. */
export interface DeliveryHandlers {
  bot?: (botId: string, urgency: Urgency, message?: ChatMessage) => void | Promise<void>;
  user?: (userId: string, urgency: Urgency) => void;
}
/** `muted`: members who muted this chat (免打扰) — the recipient's own override of the policy. */
export function plan(kind: DeliveryKind, targets: readonly DeliveryTarget[], muted: readonly string[] = []): Delivery[] {
  return targets.flatMap(target => {
    const urgency = urgencyOf(kind, target.reason);
    return urgency ? [{ ...target, kind, urgency: muted.includes(target.member.id) ? mutedUrgency(target.reason, urgency) : urgency }] : [];
  });
}
export class Dispatcher {
  constructor(private readonly handlers: DeliveryHandlers) {}
  /** After commit. A lost or failed hand-off never undoes the saved fact: the durable inbox stays. */
  dispatch(deliveries: readonly Delivery[], message?: ChatMessage): void {
    for (const delivery of deliveries) {
      const id = delivery.member.id;
      try {
        const handled = delivery.member.kind === "bot" ? this.handlers.bot?.(id, delivery.urgency, message) : this.handlers.user?.(id, delivery.urgency);
        if (handled) void Promise.resolve(handled).catch(error => console.error("[delivery] hand-off failed", { memberId: id, error }));
      } catch (error) { console.error("[delivery] hand-off failed", { memberId: id, error }); }
    }
  }
}
/** Where deliveries are written: the inbox (infra/storage), seen through the shape this module needs. */
export interface InboxWriter {
  write(entries: readonly { delivery: Pick<Delivery, "reason" | "urgency"> & { kind: DeliveryKind; member: { id: string } }; chatId: string | null;
    messageId: string | null; actorId: string | null; payload: DeliveryPayloads[DeliveryKind]; createdAt: number }[]): void;
}
/** The delivery module's one way in (A41, A61). Chat sources plan their deliveries from a route and write them with the
 * message, mark or notice they are about, then hand them off here; a system notice — about no chat, to one member — is
 * planned, written and handed off by `notify`. The urgency always comes from the policy table. */
export class Deliveries {
  private readonly dispatcher: Dispatcher;
  constructor(private readonly inbox: InboxWriter, handlers: DeliveryHandlers) { this.dispatcher = new Dispatcher(handlers); }
  /** After commit: hands committed deliveries to their recipients. */
  dispatch(deliveries: readonly Delivery[], message?: ChatMessage): void { this.dispatcher.dispatch(deliveries, message); }
  /** System notices (A61): one row per payload goes to `to`, for `reason`, with no chat; the recipient is handed them
   * once, so several changes at a time interrupt a running Bot only once. */
  notify<K extends SystemKind>(input: { to: Member; kind: K; reason: DeliveryReason; actorId: string | null; payloads: readonly DeliveryPayloads[K][] }): void {
    if (!input.payloads.length) return;
    const [delivery] = plan(input.kind, [{ member: input.to, reason: input.reason }]);
    if (!delivery) throw new Error(`No delivery policy for ${input.kind} / ${input.reason}`);
    const createdAt = Date.now();
    this.inbox.write(input.payloads.map(payload => ({ delivery, chatId: null, messageId: null, actorId: input.actorId, payload, createdAt })));
    this.dispatcher.dispatch([delivery]);
  }
}
