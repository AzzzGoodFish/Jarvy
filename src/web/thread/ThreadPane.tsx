import { useEffect, useRef, useState } from "react";
import { api, type Attachment, type Bot, type Chat, type ChatMessage, type Member } from "../api";
import { Composer } from "../composer/Composer";
import { ChannelMessages } from "../channel/ChannelView";
import { findMentions } from "../channel/mentions";
import { Icon, IconButton, Markdown } from "../ui";
import { liveMembers, memberName } from "../members";

const stamp = (time: number) => new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Title, status and summary: the thread's own small notice (A37). Anyone in the channel may edit them. */
function ThreadMeta({ chat, channelName, onTitle, onStatus, onSummary, onConclude }: {
  chat: Chat; channelName: string; onTitle: (title: string) => Promise<void>; onStatus: (status: "open" | "done") => Promise<void>;
  onSummary: (text: string) => Promise<void>; onConclude: () => Promise<void>;
}) {
  const [title, setTitle] = useState<string | null>(null), [summary, setSummary] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { setTitle(null); setSummary(null); }, [chat.id]);
  const run = async (work: () => Promise<void>, done: () => void) => { setBusy(true); try { await work(); done(); } catch { /* reported by the caller */ } finally { setBusy(false); } };
  const isDone = chat.status === "done", note = chat.note;
  return <div className="jv-thread-meta">
    <div className="jv-thread-title-row">
      {title === null ? <><h2 className="jv-thread-title">{chat.title}</h2><IconButton icon="pencil" label="修改标题" onClick={() => setTitle(chat.title)}/></>
        : <form className="jv-inline-edit" onSubmit={event => { event.preventDefault(); if (title.trim()) void run(() => onTitle(title.trim()), () => setTitle(null)); }}>
          <input value={title} autoFocus maxLength={80} aria-label="线程标题" onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setTitle(null); }}/>
          <button type="submit" className="ui-button ui-primary" disabled={busy || !title.trim()}>保存</button></form>}
      <button type="button" className="jv-status" data-done={isDone || undefined} disabled={busy} title="切换状态" onClick={() => void run(() => onStatus(isDone ? "open" : "done"), () => {})}>
        {isDone ? <><Icon name="check"/>已完成</> : "进行中"}</button>
    </div>
    {summary !== null ? <div className="jv-summary" data-editing>
      <textarea className="jv-notice-input" value={summary} autoFocus aria-label="摘要" onChange={event => setSummary(event.target.value)}/>
      <div className="jv-notice-actions"><button type="button" className="ui-button" onClick={() => setSummary(null)}>取消</button>
        <button type="button" className="ui-button ui-primary" disabled={busy || !summary.trim()} onClick={() => void run(() => onSummary(summary.trim()), () => setSummary(null))}>保存</button></div>
    </div> : note ? <div className="jv-summary">
      <div className="jv-summary-head"><strong>摘要</strong><span className="jv-muted">{note.updatedBy.name} · {stamp(note.updatedAt)} · 第 {note.version} 版</span>
        <span className="jv-spacer"/><IconButton icon="pencil" label="编辑摘要" onClick={() => setSummary(note.text)}/></div>
      <div className="jv-summary-body ui-bubble jv-flat"><Markdown text={note.text}/></div>
      {!isDone && <button type="button" className="ui-button jv-conclude" disabled={busy} onClick={() => void run(onConclude, () => {})}><Icon name="check"/>完成并把摘要发到 #{channelName}</button>}
    </div> : <button type="button" className="jv-summary-empty" onClick={() => setSummary("")}><Icon name="add"/>添加摘要</button>}
  </div>;
}

/** One thread, in the right-hand pane, over the main area (mobile: full screen), or embedded beside the followed-threads
 * list. It loads its own messages and has its own composer; a new thread pre-fills an @ to the root's sender once.
 * Embedded, onClose goes back to the list (phones) and onToggleMode opens the thread beside its channel. */
export function ThreadPane({ threadId, mode, channel, members, bots, me, tick, onClose, onToggleMode, onNav, onChanged, onInvite, onPreview, onError, onNotice }: {
  threadId: string; mode: "pane" | "full" | "embed"; channel: Chat | undefined; members: Member[]; bots: Bot[]; me: string;
  /** Bumped when the server reports a change to this thread. */
  tick: number;
  onClose: () => void; onToggleMode: () => void; onNav: () => void;
  onChanged: (chat: Chat) => void; onInvite: (member: Member) => void; onPreview: (files: Attachment[], index: number) => void;
  onError: (error: unknown) => void; onNotice: (text: string) => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null), [root, setRoot] = useState<ChatMessage | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]), [divider, setDivider] = useState<number | null>(null), [also, setAlso] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const body = useRef<HTMLDivElement>(null), opened = useRef<string | null>(null);
  useEffect(() => { setChat(null); setRoot(null); setMessages([]); setDivider(null); setAlso(false); setReplyTo(null); }, [threadId]);
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
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" }); }, [messages]);
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
  const actions = { onQuote: setReplyTo, onReact: react, onJump: jump, onError };
  const send = async (content: string, attachmentIds: string[], key: string, alsoToChannel: boolean) => {
    const quoted = replyTo && replyTo.chatId === threadId ? replyTo.id : undefined;
    await api.send(threadId, content, attachmentIds, key, alsoToChannel, quoted);
    setReplyTo(null);
    const outside = channel ? findMentions(content, liveMembers(members)).filter(hit => !channel.memberIds.includes(hit.member.id)).map(hit => hit.member.name) : [];
    if (outside.length) onNotice(`${[...new Set(outside)].join("、")} 不在频道中，未收到通知`);
    const [loaded, list] = await Promise.all([api.chat(threadId), api.messages(threadId)]);
    setChat(loaded); setMessages(list.messages); onChanged(loaded);
  };
  const channelName = channel?.title ?? "频道", rootSender = members.find(member => member.id === root?.senderId);
  const Shell = mode === "pane" ? "aside" : mode === "embed" ? "section" : "main";
  return <Shell className={mode === "pane" ? "ui-pane jv-pane" : mode === "embed" ? "ui-chat jv-thread-full jv-thread-embed" : "ui-chat jv-thread-full"} aria-label="线程">
    <header className={mode === "pane" ? "ui-pane-header jv-pane-header" : "ui-chat-header jv-pane-header"}>
      {mode === "full" && <IconButton icon="layout-sidebar-left" className="ui-mobile-only" label="打开会话列表" onClick={onNav}/>}
      {mode === "embed" && <IconButton icon="chevron-left" className="ui-mobile-only" label="返回线程列表" onClick={onClose}/>}
      {mode === "full" ? <button type="button" className="jv-crumb" onClick={onClose}><Icon name="chevron-left"/><span className="jv-hash">#</span>{channelName}</button>
        : mode === "embed" ? <button type="button" className="jv-crumb" title="在频道中查看" onClick={onToggleMode}><span className="jv-hash">#</span>{channelName}</button>
        : <><strong>线程</strong><span className="jv-muted jv-pane-sub">#{channelName}</span></>}
      <span className="jv-spacer"/>
      {chat && <button type="button" className="ui-button jv-follow" data-on={chat.following || undefined} title={chat.following ? "新回复计入未读" : "新回复不计入未读"}
        onClick={() => void save(() => api.follow(threadId, !chat.following)).catch(() => {})}><Icon name={chat.following ? "bell" : "bell-slash"}/>{chat.following ? "已关注" : "关注"}</button>}
      {mode !== "embed" && <IconButton icon={mode === "pane" ? "arrows-expand" : "arrows-contract"} className="jv-desktop-only" label={mode === "pane" ? "展开" : "收起到侧栏"} onClick={onToggleMode}/>}
      {mode === "pane" && <IconButton icon="close" label="关闭线程" onClick={onClose}/>}
    </header>
    <div ref={body} className={mode === "pane" ? "ui-pane-body jv-pane-body" : "ui-transcript jv-thread-wide"}>
      {chat && <ThreadMeta chat={chat} channelName={channelName}
        onTitle={title => save(() => api.updateThread(threadId, { title }))} onStatus={status => save(() => api.updateThread(threadId, { status }))}
        onSummary={text => save(() => api.setNote(threadId, text))}
        onConclude={async () => {
          try {
            await send(`结论：\n\n${chat.note?.text ?? ""}`, [], Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""), true);
            await save(() => api.updateThread(threadId, { status: "done" }));
            onNotice(`已完成，摘要已发到 #${channelName}`);
          } catch (error) { onError(error); throw error; }
        }}/>}
      {root && <ChannelMessages messages={[{ ...root, thread: null }]} members={members} bots={bots} me={me} divider={Number.MAX_SAFE_INTEGER}
        onSettled={() => {}} onPreview={onPreview} onReact={react} onJump={jump} onError={onError}/>}
      <div className="jv-divider" data-tone="count" role="separator"><span>{messages.length ? `${messages.length} 条回复` : "暂无回复"}</span></div>
      <ChannelMessages messages={messages} members={members} bots={bots} me={me} divider={divider ?? Number.MAX_SAFE_INTEGER}
        onSettled={updated => setMessages(previous => previous.map(item => item.id === updated.id ? updated : item))} onPreview={onPreview} {...actions}/>
    </div>
    <Composer chatId={threadId} id="jarvy-thread-composer" placeholder="回复线程" scrollRef={body} disabled={!chat}
      quote={replyTo ? { name: memberName(members.find(member => member.id === replyTo.senderId)), text: replyTo.content.replace(/\s+/g, " ").slice(0, 160) } : null}
      onCancelQuote={() => setReplyTo(null)}
      initialText={messages.length === 0 && root && root.senderId !== me && rootSender && !rootSender.deleted ? `@${rootSender.name} ` : undefined}
      mention={{ bots, inside: liveMembers(members).filter(member => member.id !== me && !!channel?.memberIds.includes(member.id)),
        outside: liveMembers(members).filter(member => !channel?.memberIds.includes(member.id)), onInvite }}
      extra={<label className="jv-also"><input type="checkbox" checked={also} onChange={event => setAlso(event.target.checked)}/>同时发到 #{channelName}</label>}
      onSend={async (content, ids, key) => { await send(content, ids, key, also); setAlso(false); }} onError={onError} onNotice={onNotice}/>
  </Shell>;
}
