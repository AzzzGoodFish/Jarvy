import { useSyncExternalStore } from "react";
import type { Attachment, ChatMessage, Member } from "../../contract/chat";
import { memberName } from "../members";
import { quotedText } from "../channel/quotes";

/** The message being answered, as the quote bar shows it. */
export interface DraftQuote { id: string; name: string; text: string }
/** A partial quote (A44): a passage selected in a message, shown as a tag. */
export interface DraftPassage { messageId: string; name: string; text: string }
/** What a message is made of: the text, pending attachments, the quoted message and quoted passages. */
export interface DraftParts { text: string | null; files: Attachment[]; quote: DraftQuote | null; passages: DraftPassage[] }
/** One chat's unsent message. `key` / `signature` keep a retried send idempotent across reloads; `outgoing` is the
 * message on its way up, out of the input until the server has it; `sending` is memory only. */
export interface Draft extends DraftParts {
  key: string | null; signature: string | null; outgoing: DraftParts | null; sending: boolean;
}
const EMPTY: Draft = { text: null, files: [], quote: null, passages: [], key: null, signature: null, outgoing: null, sending: false };

/** A message that did not get through, back in the input in front of what was typed since; nothing of it was sent. */
export function putBack(draft: Draft, sent: DraftParts): Partial<Draft> {
  const text = sent.text?.trim() ?? "", typed = draft.text ?? "";
  return { text: typed.trim() ? (text ? `${text}\n\n${typed}` : typed) : (text || draft.text),
    files: [...sent.files.filter(file => !draft.files.some(kept => kept.id === file.id)), ...draft.files],
    quote: draft.quote ?? sent.quote, passages: [...sent.passages, ...draft.passages], outgoing: null };
}
type Saved = Record<string, Omit<Draft, "sending">>;

/** Per-account drafts (text, pending attachments, quoted message, quoted passages) for every chat. Lives outside the components, so
 * switching chats or reopening a thread keeps them, and is saved to localStorage under the account's own key, so a
 * reload restores them. Pop-ups (@ menu, emoji picker) and upload progress are not drafts. */
export class DraftStore {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly storageKey: string) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Saved;
      // A message that was on its way up when the page went away: back in the input, its key kept for the retry.
      for (const [chatId, draft] of Object.entries(saved)) {
        const loaded: Draft = { ...EMPTY, ...draft, sending: false };
        this.drafts.set(chatId, loaded.outgoing ? { ...loaded, ...putBack(loaded, loaded.outgoing) } : loaded);
      }
    } catch { localStorage.removeItem(storageKey); }
  }
  get(chatId: string): Draft { return this.drafts.get(chatId) ?? EMPTY; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** Text is saved 300 ms after typing stops; anything else is saved at once. */
  update(chatId: string, change: Partial<Draft> | ((draft: Draft) => Partial<Draft>)) {
    const current = this.get(chatId), patch = typeof change === "function" ? change(current) : change;
    this.drafts.set(chatId, { ...current, ...patch });
    this.listeners.forEach(listener => listener());
    const onlyText = Object.keys(patch).every(field => field === "text" || field === "sending");
    if (this.timer) clearTimeout(this.timer);
    if (onlyText) this.timer = setTimeout(() => this.save(), 300); else this.save();
  }
  /** Writes what is worth restoring: chats with text, files, a quote, passages or a message on its way up. */
  save() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const saved: Saved = {};
    for (const [chatId, { sending: _, ...draft }] of this.drafts)
      if (draft.text?.trim() || draft.files.length || draft.quote || draft.passages.length || draft.outgoing) saved[chatId] = draft;
    if (Object.keys(saved).length) localStorage.setItem(this.storageKey, JSON.stringify(saved)); else localStorage.removeItem(this.storageKey);
  }
  /** Logging out: deletes the pending attachments on the server (failures are logged, not fatal), then the drafts. */
  async clear(removeFile: (id: string) => Promise<unknown>) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const files = [...this.drafts.values()].flatMap(draft => [...draft.files, ...draft.outgoing?.files ?? []]);
    await Promise.all(files.map(file => removeFile(file.id).catch(error => console.warn(`Pending attachment ${file.id} was not deleted on log-out`, error))));
    this.drafts.clear(); localStorage.removeItem(this.storageKey);
    this.listeners.forEach(listener => listener());
  }
}

export const draftKey = (username: string) => `jarvy-drafts:${username}`;
/** Quoting a message puts it in its chat's draft. */
export function quoteMessage(store: DraftStore, message: ChatMessage, members: Member[]) {
  store.update(message.chatId, { quote: { id: message.id, name: memberName(members.find(member => member.id === message.senderId)), text: quotedText(message).replace(/\s+/g, " ").slice(0, 160) } });
}
export function useDraft(store: DraftStore, chatId: string): Draft {
  return useSyncExternalStore(store.subscribe, () => store.get(chatId));
}
