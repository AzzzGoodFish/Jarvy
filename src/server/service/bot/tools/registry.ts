import { Type, type Static, type TSchema } from "typebox";
import type { ToolContext } from "./context.js";

/** What a handler gets besides its arguments: the call's id (a card or message it sends carries it) and its abort signal. */
export interface ToolCall { toolCallId: string; signal?: AbortSignal }
/** Short one-line summary for `chat(list)` plus full instructions for `chat(describe)` (A37, A105). */
export type ToolDoc = string | { summary: string; detail: string };
/** One tool behind the `chat` gateway (A37): its name, short list summary, full description, parameters and handler. The
 * gateway checks the arguments against the parameters before the handler runs, so the handler's are typed from them. */
export interface BotTool { name: string; summary: string; description: string; schema: TSchema; run(args: unknown, context: ToolContext, call: ToolCall): unknown }
export function tool<S extends TSchema>(name: string, doc: ToolDoc, schema: S, run: (args: Static<S>, context: ToolContext, call: ToolCall) => unknown): BotTool {
  const summary = typeof doc === "string" ? doc : doc.summary;
  const description = typeof doc === "string" ? doc : doc.detail;
  return { name, summary, description, schema, run: run as BotTool["run"] };
}
/** Parameter pieces several areas use. */
export const None = Type.Object({}, { additionalProperties: false });
export const MessageId = Type.String({ pattern: "^m\\d+$" });
