import type { ChatMessage } from "../../shared/chat.js";
import type { Delivery, DeliveryKind, DeliveryTarget, Urgency } from "../../shared/delivery.js";
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
