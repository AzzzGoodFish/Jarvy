import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Attachment, type Bot, type Chat, type ChatMessage, type Member } from "../api";
import { Composer } from "../composer/Composer";
import { quoteMessage, type DraftStore } from "../composer/drafts";
import { ChannelMessages } from "../channel/ChannelView";
import { findMentions } from "../channel/mentions";
import { Icon, IconButton } from "../ui";
import { liveMembers } from "../members";
import { ThreadMeta } from "./ThreadMeta";

/** One thread, in the right-hand pane, over the main area (mobile: full screen), or embedded beside the followed-threads
 * list. It loads its own messages and has its own composer; a new thread pre-fills an @ to the root's sender once.
 * Embedded, onClose goes back to the list (phones) and onToggleMode opens the thread beside its channel. */
export function ThreadPane({ threadId, mode, showSummary = false, focus, onSearch, channel, drafts, members, bots, me, tick, onClose, onToggleMode, onNav, onChanged, onInvite, onPreview, onError, onNotice }: {
  threadId: string; mode: "pane" | "full" | "embed";
  /** Opened from a 「更新了线程摘要」 hint: the pinned summary starts unfolded. */
  showSummary?: boolean;
  /** Opened from a search result: land on this reply (highlighted) instead of the newest. */
  focus?: string;
  /** The header's search button and Ctrl+F inside the pane: search this thread. */
  onSearch?: (thread: Chat) => void; channel: Chat | undefined; drafts: DraftStore; members: Member[]; bots: Bot[]; me: string;
  /** Bumped when the server reports a change to this thread. */
  tick: number;
  onClose: () => void; onToggleMode: () => void; onNav: () => void;
  onChanged: (chat: Chat) => void; onInvite: (member: Member) => void; onPreview: (files: Attachment[], index: number) => void;
  onError: (error: unknown) => void; onNotice: (text: string) => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null), [root, setRoot] = useState<ChatMessage | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]), [divider, setDivider] = useState<number | null>(null);
  const list = useRef(messages); list.current = messages;
  // At the bottom, and not yet moved by the opening jump: a thread is read the same way as the main transcript.
  const body = useRef<HTMLDivElement>(null), rows = useRef<HTMLDivElement>(null), opened = useRef<string | null>(null), settled = useRef(false), atBottom = useRef(true);
  // 「回到最新」, as in the main transcript: shown while away from the bottom, counting others' replies since you left it.
  const [away, setAway] = useState(false), seen = useRef(0);
  useEffect(() => { setChat(null); setRoot(null); setMessages([]); setDivider(null); settled.current = false; atBottom.current = true; setAway(false); seen.current = 0; }, [threadId]);
  useEffect(() => {
    let alive = true;
    void Promise.all([api.chat(threadId), api.messages(threadId)]).then(async ([loaded, list]) => {
      if (!alive) return;
      setChat(loaded); setMessages(list.messages);
      if (opened.current !== threadId) { opened.current = threadId; setDivider(loaded.readSequence); }
      if (loaded.rootMessageId) { const message = await api.message(loaded.rootMessageId); if (alive) setRoot(message); }
    }).catch(error => { if (alive) onError(error); });
    return () => { alive = false; };
  }, [threadId, tick]);
  // Opened (or re-opened) threads land at the newest reply, exactly; later arrivals scroll smoothly, and only when
  // the reader is at the bottom. Rows that grow afterwards (images, file cards) keep the view pinned there.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !chat) return;
    const toBottom = () => el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    const last = messages.at(-1);
    if (!settled.current) {
      if (!messages.length && !root) return;
      settled.current = true;
      const target = focus ? el.querySelector<HTMLElement>(`[data-message="${focus}"]`) : null;
      if (target) {
        atBottom.current = false; target.scrollIntoView({ block: "center" }); target.classList.add("jv-jump");
        setTimeout(() => target.classList.remove("jv-jump"), 1600); return;
      }
      toBottom(); requestAnimationFrame(toBottom);
    } else if (atBottom.current || last?.senderId === me) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    if (atBottom.current || last?.senderId === me) seen.current = last?.sequence ?? 0;
  }, [messages, root, chat]);
  useEffect(() => {
    const el = body.current, inner = rows.current;
    if (!el || !inner) return;
    const grown = new ResizeObserver(() => {
      if (!settled.current || !atBottom.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) return;
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    });
    grown.observe(inner);
    const track = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (atBottom.current) seen.current = Math.max(seen.current, list.current.at(-1)?.sequence ?? 0);
      setAway(!atBottom.current);
    };
    track(); el.addEventListener("scroll", track, { passive: true });
    return () => { grown.disconnect(); el.removeEventListener("scroll", track); };
  }, [body.current, threadId, chat]);
  // Visible replies count as read, as in the main view.
  useEffect(() => {
    const last = messages.at(-1);
    if (!chat || !last || last.chatId !== chat.id) return;
    const mark = () => {
      if (document.visibilityState !== "visible" || chat.readSequence >= last.sequence) return;
      const next = { ...chat, readSequence: last.sequence, unread: 0, mentions: 0, alerts: 0, atMe: false, hint: null };
      // Tell the parent only after the server has it, or a list refresh can bring the old count back.
      setChat(next);
      void api.markRead(chat.id, last.sequence).then(() => onChanged(next)).catch(onError);
    };
    mark(); document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [messages, chat]);

  const save = async (work: () => Promise<Chat>) => {
    try { const next = await work(); setChat(next); onChanged(next); }
    catch (error) { onError(error); throw error; }
  };
  /** Marks and replies work here as in the main view; the thread holds all its replies, so a jump only scrolls. */
  const react = async (message: ChatMessage, emoji: string, on: boolean) => {
    try {
      const updated = await api.react(message.id, emoji, on);
      const apply = (item: ChatMessage) => item.id === updated.id ? { ...item, reactions: updated.reactions } : item;
      setMessages(previous => previous.map(apply)); setRoot(previous => previous && apply(previous));
    } catch (error) { onError(error); }
  };
  const jump = (id: string) => {
    const element = body.current?.querySelector<HTMLElement>(`[data-message="${id}"]`);
    if (!element) { onNotice("原消息不在这个线程里"); return; }
    element.scrollIntoView({ block: "center" }); element.classList.add("jv-jump");
    setTimeout(() => element.classList.remove("jv-jump"), 1200);
  };
  const actions = { onQuote: (message: ChatMessage) => quoteMessage(drafts, message, members), onReact: react, onJump: jump, onError };
  /** Replies stay in the thread; only the conclusion is also posted to the channel. */
  const send = async (content: string, attachmentIds: string[], key: string, replyTo?: string, alsoToChannel = false) => {
    await api.send(threadId, content, attachmentIds, key, alsoToChannel, replyTo);
    const outside = channel ? findMentions(content, liveMembers(members)).filter(hit => !channel.memberIds.includes(hit.member.id)).map(hit => hit.member.name) : [];
    if (outside.length) onNotice(`${[...new Set(outside)].join("、")} 不在频道中，未收到通知`);
    const [loaded, list] = await Promise.all([api.chat(threadId), api.messages(threadId)]);
    setChat(loaded); setMessages(list.messages); onChanged(loaded);
  };
  const channelName = channel?.title ?? "频道", rootSender = members.find(member => member.id === root?.senderId);
  const unseen = away ? messages.filter(message => message.sequence > seen.current && message.senderId !== me).length : 0;
  const Shell = mode === "pane" ? "aside" : mode === "embed" ? "section" : "main";
  return <Shell className={mode === "pane" ? "ui-pane jv-pane" : mode === "embed" ? "ui-chat jv-thread-full jv-thread-embed" : "ui-chat jv-thread-full"} aria-label="线程"
    onKeyDown={event => { if (chat && onSearch && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); onSearch(chat); } }}>
    <header className={mode === "pane" ? "ui-pane-header jv-pane-header" : "ui-chat-header jv-pane-header"}>
      {mode === "full" && <IconButton icon="layout-sidebar-left" className="ui-mobile-only" label="打开会话列表" onClick={onNav}/>}
      {mode === "embed" && <IconButton icon="chevron-left" className="ui-mobile-only" label="返回线程列表" onClick={onClose}/>}
      {mode === "full" ? <button type="button" className="jv-crumb" onClick={onClose}><Icon name="chevron-left"/><span className="jv-hash">#</span>{channelName}</button>
        : mode === "embed" ? <button type="button" className="jv-crumb" title="在频道中查看" onClick={onToggleMode}><span className="jv-hash">#</span>{channelName}</button>
        : <><strong>线程</strong><span className="jv-muted jv-pane-sub">#{channelName}</span></>}
      <span className="jv-spacer"/>
      {chat && onSearch && <IconButton icon="search" label="搜索线程消息（Ctrl+F）" onClick={() => onSearch(chat)}/>}
      {chat && <button type="button" className="ui-button jv-follow" data-on={chat.following || undefined} title={chat.following ? "新回复计入未读" : "新回复不计入未读"}
        onClick={() => void save(() => api.follow(threadId, !chat.following)).catch(() => {})}><Icon name={chat.following ? "bell" : "bell-slash"}/>{chat.following ? "已关注" : "关注"}</button>}
      {mode !== "embed" && <IconButton icon={mode === "pane" ? "arrows-expand" : "arrows-contract"} className="jv-desktop-only" label={mode === "pane" ? "展开" : "收起到侧栏"} onClick={onToggleMode}/>}
      {mode === "pane" && <IconButton icon="close" label="关闭线程" onClick={onClose}/>}
    </header>
    {chat && <div className={mode === "pane" ? "jv-thread-pin" : "jv-thread-pin jv-thread-pin-wide"}><ThreadMeta chat={chat} channelName={channelName} expanded={showSummary}
        onTitle={title => save(() => api.updateThread(threadId, { title }))} onStatus={status => save(() => api.updateThread(threadId, { status }))}
        onSummary={text => save(() => api.setNote(threadId, text))}
        onConclude={async () => {
          try {
            await send(`结论：\n\n${chat.note?.text ?? ""}`, [], Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""), undefined, true);
            await save(() => api.updateThread(threadId, { status: "done" }));
            onNotice(`已完成，摘要已发到 #${channelName}`);
          } catch (error) { onError(error); throw error; }
        }}/></div>}
    <div ref={body} className={mode === "pane" ? "ui-pane-body jv-pane-body" : "ui-transcript jv-thread-wide"}>
      <div ref={rows}>
      {root && <ChannelMessages messages={[{ ...root, thread: null }]} members={members} bots={bots} me={me} divider={Number.MAX_SAFE_INTEGER}
        onSettled={() => {}} onPreview={onPreview} onReact={react} onJump={jump} onError={onError}/>}
      <div className="jv-divider" data-tone="count" role="separator"><span>{messages.length ? `${messages.length} 条回复` : "暂无回复"}</span></div>
      <ChannelMessages messages={messages} members={members} bots={bots} me={me} divider={divider ?? Number.MAX_SAFE_INTEGER}
        onSettled={updated => setMessages(previous => previous.map(item => item.id === updated.id ? updated : item))} onPreview={onPreview} {...actions}/>
      </div>
      {away && messages.length > 0 && <div className="jv-to-latest"><button type="button" aria-label="回到最新回复"
        onClick={() => body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" })}>
        {unseen > 0 && <span>{unseen} 条新消息</span>}<Icon name="chevron-down"/></button></div>}
    </div>
    <Composer chatId={threadId} id="jarvy-thread-composer" drafts={drafts} placeholder="回复线程" scrollRef={body} disabled={!chat}
      initialText={messages.length === 0 && root && root.senderId !== me && rootSender && !rootSender.deleted ? `@${rootSender.name} ` : undefined}
      mention={{ bots, inside: liveMembers(members).filter(member => member.id !== me && !!channel?.memberIds.includes(member.id)),
        outside: liveMembers(members).filter(member => !channel?.memberIds.includes(member.id)), onInvite }}
      onSend={send} onError={onError} onNotice={onNotice}/>
  </Shell>;
}
