import { useEffect, useRef, useState } from "react";
import type { Chat, Member } from "../api";
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
  const where = chat.type === "channel" ? `#${chat.title}` : chat.type === "thread" ? "本线程" : "本私聊";
  return <aside className="ui-pane jv-pane" aria-label="聊天内搜索">
    <header className="ui-pane-header jv-pane-header"><strong>搜索</strong><span className="jv-muted jv-pane-sub">{where}</span><span className="jv-spacer"/>
      <IconButton icon="close" label="关闭搜索" onClick={onClose}/></header>
    <div className="jv-pane-search">
      <input ref={input} type="search" value={query} placeholder={chat.type === "channel" ? "搜索频道和它的线程里的消息" : "搜索消息"} aria-label="搜索消息"
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); if (query) setQuery(""); else onClose(); } }}/>
    </div>
    <div className="ui-pane-body jv-pane-body jv-results" aria-live="polite">
      {!query.trim() ? <p className="jv-result-empty">输入要找的文字</p>
        : !result ? loading && <p className="jv-result-empty">正在搜索…</p>
        : !result.messages.length ? <p className="jv-result-empty">没有找到消息</p>
        : <>
          <p className="jv-result-count">{result.messages.length >= 60 ? "最近 60 条" : `${result.messages.length} 条`}，最新在前</p>
          {result.messages.map(({ message, chat: place }) => <MessageHit key={message.id} message={message} chat={place} chats={chats} members={members}
            query={query} showPlace={place.id !== chat.id} onOpen={onOpenMessage}/>)}
        </>}
    </div>
  </aside>;
}
