import { Type, type Static, type TSchema } from "typebox";
import type { ToolContext } from "./context.js";

/** What a handler gets besides its arguments: the call's id (a card or message it sends carries it) and its abort signal. */
export interface ToolCall { toolCallId: string; signal?: AbortSignal }
/** One tool behind the `chat` gateway (A37): its name, the description the Bot reads, its parameters and what it does. The
 * gateway checks the arguments against the parameters before the handler runs, so the handler's are typed from them. */
export interface BotTool { name: string; description: string; schema: TSchema; run(args: unknown, context: ToolContext, call: ToolCall): unknown }
export function tool<S extends TSchema>(name: string, description: string, schema: S, run: (args: Static<S>, context: ToolContext, call: ToolCall) => unknown): BotTool {
  return { name, description, schema, run: run as BotTool["run"] };
}
/** Parameter pieces several areas use. */
export const None = Type.Object({}, { additionalProperties: false });
export const MessageId = Type.String({ pattern: "^m\\d+$" });
