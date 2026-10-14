import type { MemberIdentity } from "./chat.js";

/** How urgently a recipient should learn about something (A41): interrupt = now, even mid-run; queue = soon,
 * without interrupting (a Bot is woken or gets it steered in); digest = along with the next thing. */
export type Urgency = "interrupt" | "queue" | "digest";
/** What happened. Chat kinds have their own route in `service/delivery/routes.ts`; `onboard` (the agent Bot is asked to
 * welcome the owner) and `change` (the agent Bot changed a Bot's settings) go to one Bot, from the agent service (A48). */
export type DeliveryKind = "message" | "reaction" | "note" | "onboard" | "change";
/** Why a member gets it; the policy table maps kind × reason to an urgency. */
export type DeliveryReason = "dm" | "mention" | "reply" | "subscription" | "author" | "member" | "follower" | "setup" | "agent";
/** A route's answer: who should know, and why. */
export interface DeliveryTarget { member: MemberIdentity; reason: DeliveryReason }
/** A planned delivery, written with the fact it is about and handed to the recipient after commit. */
export interface Delivery extends DeliveryTarget { kind: DeliveryKind; urgency: Urgency }
