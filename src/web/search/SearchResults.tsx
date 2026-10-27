import { useState, type ReactNode } from "react";
import type { Chat, Member } from "../../contract/chat";
import { t } from "../i18n";
import { Icon } from "../ui";
import { MessageHit, Snippet, placeOf, useSearch } from "./search";

const FIRST = 5;

/** A titled group of results that shows its first few and unfolds the rest. */
export function ResultGroup({ label, items, empty }: { label: string; items: ReactNode[]; empty?: string }) {
  const [all, setAll] = useState(false);
  if (!items.length && !empty) return null;
  return <section className="jv-result-group" aria-label={label}>
    <h3 className="jv-result-head">{label}<span>{items.length}</span></h3>
    {items.length ? (all ? items : items.slice(0, FIRST)) : <p className="jv-result-empty">{empty}</p>}
    {!all && items.length > FIRST && <button type="button" className="jv-result-more" onClick={() => setAll(true)}>{t("search.showAll", { count: items.length })}<Icon name="chevron-down"/></button>}
  </section>;
}

/** The sidebar's search, after the chats matched by name: threads and channels found by title, topic or notice /
 * summary, then messages, newest first. Opening a thread opens it beside its channel; a message opens where it is. */
export function SearchResults({ query, shown, chats, members, onOpenChat, onOpenMessage, onError }: {
  query: string; shown: Set<string>; chats: Chat[]; members: Member[];
  onOpenChat: (chat: Chat) => void; onOpenMessage: (chat: Chat, messageId: string) => void; onError: (error: unknown) => void;
}) {
  const { result, loading } = useSearch(query, undefined, onError);
  const found = (result?.chats ?? []).filter(chat => !shown.has(chat.id));
  const chatRow = (chat: Chat) => <button type="button" key={chat.id} className="jv-hit-row" onClick={() => onOpenChat(chat)}>
    <span className="jv-hit-head"><strong>{chat.type === "thread" ? chat.title : `#${chat.title}`}</strong>
      {chat.type === "thread" && <span className="jv-hit-place">{placeOf(chat, chats, members).split(" › ")[0]}</span>}</span>
    {(chat.note?.text || chat.topic) && <span className="jv-hit-text"><Snippet text={chat.note?.text || chat.topic} query={query}/></span>}
  </button>;
  return <div className="jv-results" aria-live="polite">
    <ResultGroup label={t("search.threads")} items={found.filter(chat => chat.type === "thread").map(chatRow)}/>
    <ResultGroup label={t("search.channels")} items={found.filter(chat => chat.type === "channel").map(chatRow)}/>
    {result ? <ResultGroup label={t("search.messages")} empty={t("search.noMessages")} items={result.messages.map(({ message, chat }) =>
      <MessageHit key={message.id} message={message} chat={chat} chats={chats} members={members} query={query} onOpen={onOpenMessage}/>)}/>
      : loading && <p className="jv-result-empty">{t("search.searching")}</p>}
  </div>;
}
