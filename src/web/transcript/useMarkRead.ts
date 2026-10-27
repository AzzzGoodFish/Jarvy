import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api } from "../api";
import { type Chat, type ChatMessage } from "../../contract/chat";

/** What is on screen counts as read (A37): move the open chat's read position to the last loaded message while the
 * page is visible, and clear the row's counts and hints at once. */
export function useMarkRead({ ready, selected, messages, chats, chatList, setChats, onError }: {
  ready: boolean; selected: string | null; messages: ChatMessage[]; chats: Chat[];
  /** The latest chat list, read when the page becomes visible again. */
  chatList: RefObject<Chat[]>;
  setChats: Dispatch<SetStateAction<Chat[]>>; onError: (error: unknown) => void;
}) {
  const open = chats.find(chat => chat.id === selected);
  useEffect(() => {
    const id = selected, last = messages.at(-1);
    if (!ready || !id || !last || last.chatId !== id) return;
    const mark = () => {
      const open = chatList.current.find(chat => chat.id === id);
      // Reading also counts as having seen the chat's hints (A41): marks on your messages, new notice versions.
      if (document.visibilityState !== "visible" || ((open?.readSequence ?? 0) >= last.sequence && !open?.hint && !open?.alerts)) return;
      setChats(previous => previous.map(chat => chat.id === id ? { ...chat, readSequence: Math.max(chat.readSequence, last.sequence), unread: 0, mentions: 0, alerts: 0, atMe: false, hint: null } : chat));
      void api.markRead(id, last.sequence).catch(onError);
    };
    mark(); document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [messages, selected, ready, open?.readSequence, open?.alerts, open?.hint]);
}
