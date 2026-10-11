import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Memory, Workspace } from "./contracts.js";
import { formatHistory } from "./history-format.js";

export const historyReadSchema = Type.Object({
  ids: Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), { description: "当前 Bot 自己的 History ID 列表，按输入顺序读取。" }),
  mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("detail")], { default: "summary", description: "summary 返回记录摘录；detail 返回完整通用消息内容，不含 usage/adapter extra。" })),
  format: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("markdown")], { default: "json" })),
  to_file: Type.Optional(Type.Boolean({ default: false, description: "写入当前 Bot 临时目录，只返回文件路径；false 直接返回内容。" })),
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
