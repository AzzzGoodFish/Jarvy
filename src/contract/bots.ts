/** Bots as the interface sees them (A47, A48, A50). */
import type { ErrorCode, ErrorParams } from "./errors.js";
import type { BotColor, BotMood } from "./models.js";
import type { BotPlacement } from "./environment.js";

/** A Bot. `effectiveThinkingLevel`: what `auto` comes to with its model; null without one. */
export interface Bot { id: string; name: string; description: string; systemPrompt: string; connectionId: string | null; modelId: string; thinkingLevel: string;
  effectiveThinkingLevel: string | null; workspacePath: string; color: BotColor; mood: BotMood; createdAt: number;
  /** The agent Bot (A48): the owner's helper for running Jarvy itself. */
  agent: boolean;
  /** Where its file and command tools run (A50). */
  environment: BotPlacement; }
/** A Bot's run state. `status` and `activity` are what the page shows, `phase` the finer state. `context`: what the
 * model reported with its latest reply; `stale` once a failed request was dropped from it since. */
export interface BotStatus { botId: string; status: "stop" | "idle" | "running"; activity: "reasoning" | "texting" | "tool_calling" | "asking" | null;
  phase: string; runId: string | null; error: string | null; errorCode: ErrorCode | null; errorParams?: ErrorParams;
  context?: { tokens: number | null; contextWindow: number; percent: number | null; stale: boolean }; }
/** One thing the agent Bot did with its owner's powers (A93): `tool` is the tool it used, `target` what it acted on
 * (a chat, a Bot, an environment), `detail` the rest in a line, `outcome` done, failed, or the owner's answer on a card
 * (allowed, allowed once, declined, dismissed). */
export interface AgentAction { id: number; at: number; tool: string; target: string; detail: string; outcome: string }
export interface AgentActionPage { items: AgentAction[]; nextBefore: number | null }
