import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Memory, Workspace } from "./contracts.js";
import { formatHistory } from "./history-format.js";

export const historyReadSchema = Type.Object({
  ids: Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), { description: "IDs in your own History, read in the order given." }),
  mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("detail")], { default: "summary", description: "summary returns an excerpt of each record; detail returns the full message content, without usage or adapter extras." })),
  format: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("markdown")], { default: "json" })),
  to_file: Type.Optional(Type.Boolean({ default: false, description: "Write the result to your temporary directory and return only its path; false returns the content directly." })),
}, { additionalProperties: false });
export type HistoryReadInput = Static<typeof historyReadSchema>;

export async function readHistory(memory: Memory, workspace: Workspace, input: HistoryReadInput, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const format = input.format ?? "json";
  const result = memory.readMany(input.ids, input.mode ?? "summary");
  const rendered = formatHistory(result, format);
  signal?.throwIfAborted();
  if (!input.to_file) return rendered;
  const name = `history-${randomUUID()}.${format === "json" ? "json" : "md"}`;
  return workspace.writeTempFile(name, rendered, signal);
}
