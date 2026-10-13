import { LIVE_INPUT, LIVE_MESSAGE, type LiveChat, type LiveInput } from "../../shared/live.js";

/** Cuts text to `length` characters, marking the cut with an ellipsis. */
export function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
const field = (value: unknown, length = LIVE_INPUT) => typeof value === "string" ? clip(value, length) : undefined;
type Args = Record<string, unknown>;
const record = (value: unknown): Args => value && typeof value === "object" && !Array.isArray(value) ? value as Args : {};

/** What a tool call works on (A47), from its arguments: the file (read, edit, write), the start of the command or
 * script (bash, codemode), or for the chat gateway the tool inside it, with the chat and the text of a message or a
 * question. `chat` looks a chat up as the Bot sees it. */
export function liveInput(tool: string, args: unknown, chat: (chatId: string) => LiveChat | null): LiveInput {
  const values = record(args);
  switch (tool) {
    case "bash": return { command: field(values.command) };
    case "read": case "edit": case "write": return { path: field(values.path) };
    case "codemode": return { command: field(values.code) };
    case "chat": return gateway(values, chat);
    default: {
      let json = ""; try { json = JSON.stringify(args) ?? ""; } catch { /* not serialisable: nothing to show */ }
      return json ? { args: clip(json, LIVE_INPUT) } : {};
    }
  }
}
function gateway(values: Args, chat: (chatId: string) => LiveChat | null): LiveInput {
  const action = values.action === "call" && typeof values.tool === "string" ? values.tool : typeof values.action === "string" ? values.action : "";
  const inner = record(values.args), where = target(inner, chat);
  if (action === "messages.send") return { action, chat: where, text: field(inner.message, LIVE_MESSAGE) };
  if (action === "messages.ask") return { action, chat: where, text: field(inner.question, LIVE_MESSAGE),
    options: Array.isArray(inner.options) ? inner.options.map(option => field(record(option).label) ?? "").filter(Boolean) : undefined };
  return where ? { action, chat: where } : { action };
}
/** Where a message goes: a DM by name (its chat is known once sent), or a chat by ID. */
function target(inner: Args, chat: (chatId: string) => LiveChat | null): LiveChat | undefined {
  if (typeof inner.to === "string") return { id: null, type: "dm", title: clip(inner.to, 80) };
  return typeof inner.chatId === "string" ? chat(inner.chatId) ?? undefined : undefined;
}
/** A sent message's chat, from the tool's result (`{ chatId, … }`): a DM opened by name or a thread reply lands in a
 * chat the arguments did not name. */
export function sentChat(output: string, chat: (chatId: string) => LiveChat | null): LiveChat | undefined {
  try {
    const chatId = (JSON.parse(output) as { chatId?: unknown }).chatId;
    return typeof chatId === "string" ? chat(chatId) ?? undefined : undefined;
  } catch { return undefined; }
}
