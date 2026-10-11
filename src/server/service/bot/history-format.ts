import type { HistoryContent, HistoryReadResult, JsonValue } from "../../shared/history.js";

export type HistoryFormat = "json" | "markdown";
// Original text/arguments can themselves contain Markdown fences. Keep them intact.
function fence(text: string, language = "text"): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const marker = "`".repeat(length);
  return `${marker}${language}\n${text}\n${marker}`;
}
const jsonBlock = (value: JsonValue) => fence(JSON.stringify(value, null, 2), "json");
function content(blocks: readonly HistoryContent[], heading = "###"): string {
  return blocks.map((block, index) => {
    const title = `${heading} ${index + 1}. ${block.type}`;
    switch (block.type) {
      case "text": case "reasoning": return `${title}\n\n${fence(block.text)}`;
      case "image": return `${title}\n\n${jsonBlock({ mime_type: block.mime_type, data: block.data })}`;
      case "tool_call": return `${title}\n\n${jsonBlock({ name: block.name, tool_call_id: block.tool_call_id, arguments: block.arguments })}`;
      case "tool_result": {
        const fields: Record<string, JsonValue> = { name: block.name, tool_call_id: block.tool_call_id, is_error: block.is_error };
        if (block.result.details !== undefined) fields.details = block.result.details;
        return `${title}\n\n${jsonBlock(fields)}\n\n${content(block.result.content, heading + "#")}`;
      }
    }
  }).join("\n\n");
}
export function formatHistory(result: HistoryReadResult, format: HistoryFormat): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const sections = [`# History (${result.mode})`];
  for (const record of result.records) {
    sections.push(`## #${record.id} · ${record.role}`, `Time: ${new Date(record.timestamp).toISOString()}`);
    if (record.model) sections.push(`Model:\n\n${jsonBlock(record.model)}`);
    if ("preview" in record) { sections.push(fence(record.preview)); continue; }
    sections.push(content(record.message.content));
    if (record.message.tools !== undefined) sections.push("### Tool definitions", jsonBlock(record.message.tools));
    if (record.message.tools_removed !== undefined) sections.push("### Tools removed", jsonBlock(record.message.tools_removed));
    if (record.message.stop_reason !== undefined) sections.push("### Stop reason", fence(record.message.stop_reason));
    if (record.message.error !== undefined) sections.push("### Error", fence(record.message.error));
  }
  if (result.missingIds.length) sections.push(`## Missing IDs\n\n${result.missingIds.join(", ")}`);
  return sections.join("\n\n") + "\n";
}
