import { useEffect, useRef } from "react";
import type { Chat, ChatMessage } from "../contract/chat";

/** A change the page heard of (A72): a new message, one changed in place, a chat as its row shows it, or a new
 * connection the server couldn't tell what was missed: what a pane shows is read again. */
export type Heard = { kind: "message" | "updated"; message: ChatMessage } | { kind: "chat"; chat: Chat } | { kind: "reconnected" };

/** Hands each change the page hears of to the open panes; each takes what is about what it shows. */
export class LiveHub {
  private readonly listeners = new Set<(heard: Heard) => void>();
  emit(heard: Heard) { for (const listener of this.listeners) listener(heard); }
  on(listener: (heard: Heard) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

/** Hears changes while mounted; always the latest `listener`, so it reads the current state. */
export function useHeard(hub: LiveHub, listener: (heard: Heard) => void) {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => hub.on(heard => latest.current(heard)), [hub]);
}

/** A changed message, in place of the loaded one; nothing changes when it is not loaded. */
export const replaceMessage = (list: ChatMessage[], message: ChatMessage) =>
  list.some(item => item.id === message.id) ? list.map(item => item.id === message.id ? message : item) : list;

/** A new message, in sequence order among the loaded run of its chat's messages (in place, if it is there already);
 * one from before the run is not loaded and stays out. */
export function addMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (list.some(item => item.id === message.id)) return replaceMessage(list, message);
  if (list[0] && message.sequence < list[0].sequence) return list;
  const after = list.findIndex(item => item.sequence > message.sequence);
  return after < 0 ? [...list, message] : [...list.slice(0, after), message, ...list.slice(after)];
}

/** Whether messages are missing before a new one: the loaded run ends at `newest` (0: nothing loaded). */
export const missingBefore = (message: ChatMessage, newest: number) => message.sequence > newest + 1;

/** A page read from `after` on, joined to what is loaded: what is before it stays, and so do messages heard of
 * meanwhile that are newer than the page. */
export function joinPage(list: ChatMessage[], page: ChatMessage[], after: number): ChatMessage[] {
  const end = page.at(-1)?.sequence ?? after;
  return [...list.filter(item => item.sequence <= after), ...page, ...list.filter(item => item.sequence > end)];
}
