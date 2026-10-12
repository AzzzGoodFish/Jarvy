import { ChatError, type QuoteDraft } from "../../shared/chat.js";
import { quoteComparable, quoteMarks, type MessageQuote } from "../../shared/quotes.js";
import type { ChatRepository } from "../../infra/storage/chat-repository.js";

const MAX_QUOTES = 10;
/** The `quotes` field of a send request (A44): at most 10 `{ messageId, text }`. */
export function quoteDrafts(value: unknown): QuoteDraft[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_QUOTES || !value.every(item => item && typeof item === "object" && !Array.isArray(item)
    && typeof item.messageId === "string" && /^m\d+$/.test(item.messageId) && typeof item.text === "string" && item.text.trim() && item.text.length <= 32_000
    && Object.keys(item).every(key => key === "messageId" || key === "text"))) throw new ChatError(400, "Invalid quotes");
  return value.map(item => ({ messageId: item.messageId as string, text: (item.text as string).trim() }));
}
/** Checks partial quotes against the message and their sources (A44): every `[[qN]]` mark matches one quote and every
 * quote is marked; a source is in the same chat, or is the thread's root when sending in a thread, and readable by the
 * sender; the text is part of the source, ignoring whitespace and Markdown markup. A message without quotes is not
 * checked for marks, so text that merely looks like one stays text. */
export function resolveQuotes(repository: ChatRepository, actorId: string, chatId: string, content: string, drafts: readonly QuoteDraft[]): MessageQuote[] {
  if (!drafts.length) return [];
  const marks = quoteMarks(content);
  if (marks.length !== drafts.length || new Set(marks).size !== marks.length || !marks.every(n => n >= 1 && n <= drafts.length))
    throw new ChatError(400, "Each quote needs exactly one [[qN]] mark");
  const chat = repository.getChat(actorId, chatId);
  if (!chat) throw new ChatError(404, "Chat not found");
  return drafts.map(draft => {
    const source = repository.message(actorId, draft.messageId);
    if (!source || (source.chatId !== chatId && !(chat.type === "thread" && chat.rootMessageId === source.id)))
      throw new ChatError(400, "Quoted message is not in this chat");
    const passage = quoteComparable(draft.text);
    if (!passage || !quoteComparable(source.content).includes(passage)) throw new ChatError(400, "Quoted text is not part of the message");
    return { messageId: source.id, senderId: source.sender.id, text: draft.text };
  });
}
