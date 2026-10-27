import type { Member } from "../../contract/chat.js";
import type { BotChange, WelcomeLanguage } from "./agent.js";

/** How urgently a recipient should learn about something (A41): interrupt = now, even mid-run; queue = soon,
 * without interrupting (a Bot is woken or gets it steered in); digest = along with the next thing. */
export type Urgency = "interrupt" | "queue" | "digest";
/** What happened. Chat kinds have their own route in `service/delivery/routes.ts`; `onboard` (the agent Bot is asked to
 * welcome the owner) and `change` (a Bot's settings or work environment changed) go to one Bot from the agent and Bot
 * services (A48, A50); `task` (one of its scheduled tasks is due) goes to one Bot from the scheduler (A58). */
export type DeliveryKind = "message" | "reaction" | "note" | "onboard" | "change" | "task";
/** The three categories (A61): a chat message; chat activity (a mark, a new notice or summary version), about a chat;
 * a system notice to one member, about no chat. Only the chat categories carry a chat. */
export type DeliveryCategory = "message" | "activity" | "system";
export const CATEGORY: Record<DeliveryKind, DeliveryCategory> = {
  message: "message", reaction: "activity", note: "activity", onboard: "system", change: "system", task: "system",
};
export type SystemKind = "onboard" | "change" | "task";
/** What each kind carries besides who and where, kept as JSON (`inbox.payload`). */
export interface DeliveryPayloads {
  message: null;
  reaction: { emoji: string };
  note: { version: number };
  onboard: { language: WelcomeLanguage };
  change: BotChange;
  task: { task: string; due: number };
}
/** Why a member gets it; the policy table maps kind × reason to an urgency. `owner` is the owner changing where a
 * Bot works; `move` is that change moving a Bot that is running. */
export type DeliveryReason = "dm" | "mention" | "reply" | "subscription" | "author" | "member" | "follower" | "setup" | "agent" | "owner" | "move" | "schedule";
/** A route's answer: who should know, and why. */
export interface DeliveryTarget { member: Member; reason: DeliveryReason }
/** A planned delivery, written with the fact it is about and handed to the recipient after commit. */
export interface Delivery extends DeliveryTarget { kind: DeliveryKind; urgency: Urgency }
