import { useEffect, useRef, useState } from "react";
import type { Chat, Member } from "../../contract/chat";
import { t } from "../i18n";
import { IconButton } from "../ui";
import { MessageHit, useSearch } from "./search";

/** Search inside one chat (a channel includes its threads), in the right-hand pane; Ctrl+F opens it. A result opens
 * where the message is: the main transcript, or its thread beside the channel. */
export function SearchPane({ chat, chats, members, focusKey, onOpenMessage, onClose, onError }: {
  chat: Chat; chats: Chat[]; members: Member[];
  /** Bumped by Ctrl+F while the pane is open, to focus the box again. */
  focusKey: number;
  onOpenMessage: (chat: Chat, messageId: string) => void; onClose: () => void; onError: (error: unknown) => void;
}) {
  const [query, setQuery] = useState(""), input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusKey, chat.id]);
  const { result, loading } = useSearch(query, chat.id, onError);
  const where = chat.type === "channel" ? `#${chat.title}` : t(chat.type === "thread" ? "search.inThread" : "search.inDm");
  return <aside className="ui-pane jv-pane jv-search-pane" aria-label={t("search.paneLabel")}>
    <header className="ui-pane-header jv-pane-header"><strong>{t("search.title")}</strong><span className="jv-muted jv-pane-sub">{where}</span><span className="jv-spacer"/>
      <IconButton icon="close" label={t("search.close")} onClick={onClose}/></header>
    <div className="jv-pane-search">
      <input ref={input} type="search" value={query} placeholder={t(chat.type === "channel" ? "search.channelPlaceholder" : "search.placeholder")} aria-label={t("search.placeholder")}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); if (query) setQuery(""); else onClose(); } }}/>
    </div>
    <div className="ui-pane-body jv-pane-body jv-results" aria-live="polite">
      {!query.trim() ? <p className="jv-result-empty">{t("search.prompt")}</p>
        : !result ? loading && <p className="jv-result-empty">{t("search.searching")}</p>
        : !result.messages.length ? <p className="jv-result-empty">{t("search.noMessages")}</p>
        : <>
          <p className="jv-result-count">{t(result.messages.length >= 60 ? "search.countLatest" : "search.count", { count: result.messages.length })}</p>
          {result.messages.map(({ message, chat: place }) => <MessageHit key={message.id} message={message} chat={place} chats={chats} members={members}
            query={query} showPlace={place.id !== chat.id} onOpen={onOpenMessage}/>)}
        </>}
    </div>
  </aside>;
}
