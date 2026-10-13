import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Chat, ChatMessage } from "../api";
import type { Pane } from "../pane";

/** Opening search results (and quote tags pointing elsewhere, A44), and Ctrl+F. A message opens where it is: in the
 * main transcript (scrolled to and highlighted once its chat has loaded) or in its thread beside the channel; with a
 * passage, that passage is highlighted. Ctrl+F opens search inside the open
 * chat; pressed again while that search box has focus, it is left to the browser. */
export function useFind({ selected, chats, transcript, openChat, setPane, paneRef, blocked }: {
  selected: string | null; chats: Chat[];
  transcript: { messages: ChatMessage[]; loading: boolean; toMessage: (id: string, passage?: string) => Promise<unknown> };
  openChat: (chat: Chat) => void; setPane: Dispatch<SetStateAction<Pane | null>>; paneRef: MutableRefObject<Pane | null>; blocked: boolean;
}) {
  const [pending, setPending] = useState<{ chatId: string; id: string; passage?: string } | null>(null), [focusKey, setFocusKey] = useState(0);
  useEffect(() => {
    if (!pending || selected !== pending.chatId || transcript.loading || transcript.messages[0]?.chatId !== pending.chatId) return;
    void transcript.toMessage(pending.id, pending.passage); setPending(null);
  }, [pending, selected, transcript.loading, transcript.messages]);
  function openMessage(chat: Chat, id: string, passage?: string) {
    if (chat.type === "thread") {
      const channel = chats.find(item => item.id === chat.parentId);
      // openChat also closes the phone's sidebar, even when the channel is already open.
      if (channel) openChat(channel);
      setPane({ kind: "thread", id: chat.id, parentId: chat.parentId!, mode: "pane", focus: { id, passage } });
      return;
    }
    // On a phone the search pane covers the chat; get it out of the way.
    if (paneRef.current?.kind === "search" && window.matchMedia("(max-width: 760px)").matches) setPane(null);
    const here = chat.id === selected;
    openChat(chat);
    if (here) void transcript.toMessage(id, passage); else setPending({ chatId: chat.id, id, passage });
  }
  function search(chat: Chat) { setPane({ kind: "search", chat }); setFocusKey(key => key + 1); }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (blocked || event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      const current = chats.find(chat => chat.id === selected);
      if (!current) return;
      if (paneRef.current?.kind === "search" && document.activeElement?.closest(".jv-search-pane")) return;
      event.preventDefault(); search(current);
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [blocked, chats, selected]);
  return { openMessage, search, focusKey };
}
