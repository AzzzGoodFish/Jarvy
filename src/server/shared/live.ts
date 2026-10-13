/** The turn a Bot is running, live (A47). Pi's events become `LiveEvent`s in `infra/pi`; the service keeps the
 * current turn in memory as steps and sends changes to the Bot's DM page. Structure only: the interface words it. */

/** What the session reports, already free of Pi's types. `key` tells streamed blocks apart within a turn. */
export type LiveEvent =
  | { type: "start" }
  | { type: "end"; outcome: "completed" | "interrupted" | "failed" }
  | { type: "block_start"; key: string; kind: "thinking" | "text" }
  | { type: "block_delta"; key: string; kind: "thinking" | "text"; delta: string }
  | { type: "block_end"; key: string }
  | { type: "tool_start"; id: string; parentId: string | null; name: string; args: unknown }
  | { type: "tool_end"; id: string; output: string; failed: boolean }
  | { type: "compaction_start" }
  | { type: "compaction_end"; failed: boolean; error: string | null; tokensBefore: number | null; tokensAfter: number | null }
  | { type: "retry_start"; attempt: number; maxAttempts: number; error: string }
  | { type: "retry_end"; failed: boolean; error: string | null };

/** A chat a message went to or a question was asked in; `id` is null until known (a DM opened by name). */
export interface LiveChat { id: string | null; type: "dm" | "channel" | "thread"; title: string; }
/** What a tool call works on, summarised: the file, the start of the command or script, or for the chat gateway the
 * tool inside it with the chat and the text of a message or question. */
export interface LiveInput {
  path?: string; command?: string; action?: string; chat?: LiveChat; text?: string; options?: string[];
  /** Any other arguments, as clipped JSON. */
  args?: string;
}
/** A long output keeps its start and end; `omitted` characters are left out between them. */
export interface LiveOutput { head: string; tail: string; omitted: number; }
export type LiveStepKind = "thinking" | "text" | "tool" | "compaction" | "retry";
export interface LiveStep {
  id: string; kind: LiveStepKind; state: "running" | "ok" | "failed"; startedAt: number; endedAt: number | null;
  /** A call made from inside another tool (codemode): that tool's call. */
  parentId: string | null;
  /** Tools: the tool's name and what it works on. */
  tool?: string; input?: LiveInput;
  /** Thinking and text: the latest part, at most `LIVE_TEXT` characters; `omitted` earlier characters were dropped. */
  text?: string; omitted?: number;
  /** Tools: the result or error. Compaction: tokens before and after. Retry: the error being retried. */
  output?: LiveOutput | null;
  tokensBefore?: number | null; tokensAfter?: number | null; attempt?: number; maxAttempts?: number;
}
export interface LiveTurn {
  startedAt: number; steps: LiveStep[];
  /** Finished steps dropped to stay within `LIVE_STEPS`. */
  dropped: number;
}
/** Changes since the last flush: a step added or changed (sent whole), text streamed into one, or a step dropped. */
export type LivePatch = { op: "step"; step: LiveStep } | { op: "text"; id: string; append: string } | { op: "drop"; id: string };
export type LiveUpdate =
  | { type: "start"; turn: LiveTurn }
  | { type: "patch"; patches: LivePatch[] }
  | { type: "end"; outcome: "completed" | "interrupted" | "failed"; endedAt: number };

/** Limits for one turn: steps kept, characters of thinking or text per step, characters kept at each end of an
 * output, and the length of an input summary or a message's text. */
export const LIVE_STEPS = 300, LIVE_TEXT = 4000, LIVE_OUTPUT_END = 1200, LIVE_INPUT = 300, LIVE_MESSAGE = 2000;
