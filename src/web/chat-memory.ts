import type { Chat, ChatMessage } from "../contract/chat";
import { addMessage, missingBefore, replaceMessage, type Heard } from "./live";

/** Where the reader was: at the newest message, or with a message's top this far below the top of the view. */
export type Place = { bottom: true } | { bottom: false; id: string; offset: number };
/** What was on screen of a chat or thread when it was left. `seen`: the newest message read at the bottom (for
 * 「回到最新」's count); `chat` and `root`: a thread's row and root message. */
export interface Remembered { messages: ChatMessage[]; hasOlder: boolean; place: Place; seen: number; chat?: Chat; root?: ChatMessage | null }

/** Chats and threads remembered at most, and messages in one: a chat with more is read again when opened. */
const KEEP = 20, MESSAGES = 500;

/** The chats and threads opened last, as they were left (A79): going back to one shows it at once, where it was, and
 * reads nothing. The live events keep them current while they are off screen (A72); one they can't vouch for — a
 * gap before a new message, a connection that didn't resume — is forgotten and read again when opened. */
export class ChatMemory {
  private readonly kept = new Map<string, Remembered>();
  /** The remembered chat, handed to the pane opening it, which keeps it current until it leaves and gives it back. */
  take(id: string): Remembered | undefined {
    const entry = this.kept.get(id);
    this.kept.delete(id);
    return entry;
  }
  keep(id: string, entry: Remembered) {
    this.kept.delete(id);
    if (entry.messages.length > MESSAGES) return;
    this.kept.set(id, entry);
    for (const oldest of this.kept.keys()) { if (this.kept.size <= KEEP) break; this.kept.delete(oldest); }
  }
  /** A channel deleted: it and its threads. */
  removed(chatId: string) { for (const [id, entry] of this.kept) if (id === chatId || entry.chat?.parentId === chatId) this.kept.delete(id); }
  clear() { this.kept.clear(); }
  /** A change heard of: put in the chats it is about, as the open panes do. */
  heard(heard: Heard) {
    if (heard.kind === "chat") { const entry = this.kept.get(heard.chat.id); if (entry?.chat) entry.chat = heard.chat; return; }
    const message = heard.message;
    for (const entry of this.kept.values()) if (entry.root?.id === message.id) entry.root = message;
    const entry = this.kept.get(message.chatId);
    if (!entry) return;
    if (heard.kind === "updated" || entry.messages.some(item => item.id === message.id)) { entry.messages = replaceMessage(entry.messages, message); return; }
    const last = entry.messages.at(-1);
    if ((last && missingBefore(message, last.sequence)) || entry.messages.length >= MESSAGES) { this.kept.delete(message.chatId); return; }
    entry.messages = addMessage(entry.messages, message);
  }
}

/** Where the reader is in a scrolled list of `[data-message]` rows: the first row that starts in view (one cut off at
 * the top can still grow above what is seen), else the one cut off. Within `near` px of the end counts as the bottom. */
export function placeOf(el: HTMLElement, near: number): Place {
  if (el.scrollHeight - el.scrollTop - el.clientHeight < near) return { bottom: true };
  const view = el.getBoundingClientRect();
  let cut: Place | undefined;
  for (const row of el.querySelectorAll<HTMLElement>("[data-message]")) {
    const box = row.getBoundingClientRect();
    if (box.bottom <= view.top) continue;
    const place: Place = { bottom: false, id: row.dataset.message!, offset: box.top - view.top };
    if (box.top >= view.top && box.top < view.bottom) return place;
    cut ??= place;
    if (box.top >= view.bottom) break;
  }
  return cut ?? { bottom: true };
}
/** Back to a place; false when its message isn't there (the caller goes to the bottom). */
export function restorePlace(el: HTMLElement, place: Place): boolean {
  if (place.bottom) return false;
  const row = el.querySelector<HTMLElement>(`[data-message="${place.id}"]`);
  if (!row) return false;
  el.scrollTo({ top: el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - place.offset, behavior: "instant" });
  return true;
}
/** Keeps a place gone back to while the rows above it finish their layout (long messages folding, pictures not seen
 * before loading), until the reader scrolls or the pane moves on its own. Meanwhile the scroll position is the hold's,
 * not the reader's: it doesn't count as leaving the bottom or as a place to remember. */
export class Hold {
  private stop: (() => void) | undefined;
  get on() { return this.stop !== undefined; }
  start(el: HTMLElement, place: Place) {
    this.release();
    const watch = new ResizeObserver(() => restorePlace(el, place));
    for (const child of el.children) watch.observe(child);
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const, release = () => this.release();
    for (const input of inputs) el.addEventListener(input, release, { passive: true });
    this.stop = () => { watch.disconnect(); for (const input of inputs) el.removeEventListener(input, release); };
  }
  release() { this.stop?.(); this.stop = undefined; }
}
