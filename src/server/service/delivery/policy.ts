import type { DeliveryKind, DeliveryReason, Urgency } from "../../shared/delivery.js";

/** Kind × reason → urgency (A41). The same for people and Bots; each decides how to respond.
 * A missing cell means that reason does not deliver that kind. */
const POLICY: Record<DeliveryKind, Partial<Record<DeliveryReason, Urgency>>> = {
  // A message to you interrupts, whether by DM, @, a reply to you or a subscription (A05, A38).
  message: { dm: "interrupt", mention: "interrupt", reply: "interrupt", subscription: "interrupt" },
  // Marks on your messages are queued: they wake you but never interrupt (A39).
  reaction: { author: "queue" },
  // A new version of a notice or summary is queued like a mark.
  note: { member: "queue", follower: "queue" },
  // The owner just gave the agent Bot its first model: it should welcome them now (A48).
  onboard: { setup: "interrupt" },
  // What the agent Bot changed about a Bot, or the owner about where it works, rides along with that Bot's next batch,
  // without waking it. The owner moving a Bot that is running stops its turn like an @, so it doesn't go on in the old
  // place (A50).
  change: { agent: "digest", owner: "digest", move: "interrupt" },
  // A task that is due wakes its Bot but never interrupts it, and is not steered into a running turn: it waits for
  // the turn to end (A58).
  task: { schedule: "queue" },
};
export function urgencyOf(kind: DeliveryKind, reason: DeliveryReason): Urgency | undefined { return POLICY[kind][reason]; }
/** 免打扰: what would interrupt is queued instead, except being @-ed or replied to. */
export function mutedUrgency(reason: DeliveryReason, urgency: Urgency): Urgency {
  return urgency === "interrupt" && reason !== "mention" && reason !== "reply" ? "queue" : urgency;
}
