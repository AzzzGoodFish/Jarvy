import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { type Attachment, type Chat, type ChatMessage, type Member } from "../../contract/chat";
import { type Bot } from "../../contract/bots";
import { Composer } from "../composer/Composer";
import { quoteMessage, type DraftStore } from "../composer/drafts";
import { ChannelMessages } from "../channel/ChannelView";
import { highlightPassage, jumpToPassage, QuoteSelection } from "../channel/quotes";
import type { Focus } from "../pane";
import { findMentions } from "../../contract/mentions";
import { Icon, IconButton } from "../ui";
import { liveMembers } from "../members";
import { t } from "../i18n";
import { ThreadMeta } from "./ThreadMeta";
import { addMessage, joinPage, missingBefore, replaceMessage, useHeard, type LiveHub } from "../live";

/** Replies loaded at a time (A71), as in the main transcript. */
const PAGE = 50;
type Replies = { messages: ChatMessage[]; hasOlder?: boolean; after?: number };

/** One thread, in the right-hand pane, over the main area (mobile: full screen), or embedded beside the followed-threads
 * list. It loads its own messages and has its own composer; a new thread pre-fills an @ to the root's sender once.
 * Embedded, onClose goes back to the list (phones) and onToggleMode opens the thread beside its channel. */
export function ThreadPane({ threadId, mode, showSummary = false, focus, onSearch, channel, drafts, members, bots, me, live, onClose, onToggleMode, onNav, onChanged, onInvite, onPreview, onError, onNotice }: {
  threadId: string; mode: "pane" | "full" | "embed";
  /** Opened from a 「更新了线程摘要」 hint: the pinned summary starts unfolded. */
  showSummary?: boolean;
  /** Opened from a search result or a quote tag: land on this reply instead of the newest, with the quoted passage
   * highlighted, or the whole reply flashed. */
  focus?: Focus;
  /** The header's search button and Ctrl+F inside the pane: search this thread. */
  onSearch?: (thread: Chat) => void; channel: Chat | undefined; drafts: DraftStore; members: Member[]; bots: Bot[]; me: string;
  /** Changes heard of (A72): new replies, the replies and the root changed, the thread itself, put in place. */
  live: LiveHub;
  onClose: () => void; onToggleMode: () => void; onNav: () => void;
  onChanged: (chat: Chat) => void; onInvite: (member: Member) => void; onPreview: (files: Attachment[], index: number) => void;
  onError: (error: unknown) => void; onNotice: (text: string) => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null), [root, setRoot] = useState<ChatMessage | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]), [divider, setDivider] = useState<number | null>(null);
  // The newest page of replies first, older ones as you scroll up (A71): a long thread loads and lays out what is seen.
  const [hasOlder, setHasOlder] = useState(false), [loadingOlder, setLoadingOlder] = useState(false);
  const list = useRef(messages), older = useRef(hasOlder), top = useRef<HTMLDivElement>(null), anchor = useRef<number | null>(null), busy = useRef(false);
  list.current = messages; older.current = hasOlder;
  // At the bottom, and not yet moved by the opening jump: a thread is read the same way as the main transcript.
  const body = useRef<HTMLDivElement>(null), rows = useRef<HTMLDivElement>(null), opened = useRef<string | null>(null), settled = useRef(false), atBottom = useRef(true);
  // 「回到最新」, as in the main transcript: shown while away from the bottom, counting others' replies since you left it.
  const [away, setAway] = useState(false), seen = useRef(0);
  // The newest reply already laid out: a reload (reading the thread changes it) brings nothing new to scroll to.
  // `ahead`: the newest reply put in since the last render, so a burst of them is not taken for a gap.
  const newest = useRef(0), ahead = useRef(0);
  useEffect(() => { setChat(null); setRoot(null); setMessages([]); setHasOlder(false); setDivider(null); settled.current = false; atBottom.current = true; setAway(false); seen.current = 0; newest.current = 0; ahead.current = 0; }, [threadId]);
  /** The replies from a little before this one to the newest, to land on it; null when it is not a reply here. */
  const around = async (id: string): Promise<Replies | null> => {
    const target = await api.message(id).catch(() => null);
    if (!target || target.chatId !== threadId) return null;
    const after = Math.max(0, target.sequence - 1 - PAGE / 2);
    return { ...await api.messages(threadId, after), hasOlder: after > 0 };
  };
  /** What is loaded, read again from its first reply on, so new replies, answers and marks show; the newest page when
   * nothing is loaded yet, or the replies around the one this pane was opened on. */
  const replies = async (): Promise<Replies> => {
    const first = list.current[0];
    if (first?.chatId === threadId) return { ...await api.messages(threadId, first.sequence - 1), after: first.sequence - 1 };
    return (focus && opened.current !== threadId ? await around(focus.id) : null) ?? await api.latestMessages(threadId, PAGE);
  };
  // A page prepended meanwhile stays, and so do replies heard of meanwhile.
  const take = (page: Replies) => {
    const after = page.after;
    setMessages(previous => after === undefined ? page.messages : joinPage(previous.filter(item => item.chatId === threadId), page.messages, after));
    if (page.hasOlder !== undefined) setHasOlder(page.hasOlder);
  };
  /** A new reply, sent here or heard of: put after the newest, or read with what is missing before it. */
  const place = (message: ChatMessage) => {
    const loaded = list.current, last = loaded.at(-1), newest = Math.max(last?.chatId === threadId ? last.sequence : 0, ahead.current);
    if (missingBefore(message, newest) && !loaded.some(item => item.id === message.id)) { void replies().then(take).catch(onError); return; }
    ahead.current = Math.max(ahead.current, message.sequence);
    setMessages(previous => addMessage(previous, message));
  };
  useHeard(live, heard => {
    if (heard.kind === "chat") {
      // Its row as the server has it; the read position may be behind the one this pane just marked.
      const next = heard.chat;
      if (next.id === threadId) setChat(previous => previous && { ...next, readSequence: Math.max(previous.readSequence, next.readSequence) });
      return;
    }
    const message = heard.message;
    if (message.id === root?.id) setRoot(message);
    else if (message.chatId === threadId) { if (heard.kind === "message") place(message); else setMessages(previous => replaceMessage(previous, message)); }
  });
  const loadOlder = async () => {
    const first = list.current[0], el = body.current;
    if (!first || !older.current || busy.current) return;
    busy.current = true; setLoadingOlder(true);
    try {
      const page = await api.olderMessages(threadId, first.sequence, PAGE);
      if (list.current[0]?.id !== first.id) return;
      anchor.current = el ? el.scrollHeight - el.scrollTop : null;
      setMessages(previous => previous[0]?.id === first.id ? [...page.messages, ...previous] : previous); setHasOlder(page.hasOlder);
    } catch (error) { onError(error); }
    finally { busy.current = false; setLoadingOlder(false); }
  };
  useEffect(() => {
    let alive = true;
    void Promise.all([api.chat(threadId), replies()]).then(async ([loaded, page]) => {
      if (!alive) return;
      setChat(loaded); take(page);
      if (opened.current !== threadId) { opened.current = threadId; setDivider(loaded.readSequence); }
      if (loaded.rootMessageId) { const message = await api.message(loaded.rootMessageId); if (alive) setRoot(message); }
    }).catch(error => { if (alive) onError(error); });
    return () => { alive = false; };
  }, [threadId]);
  // Opened (or re-opened) threads land at the newest reply, exactly; later arrivals scroll smoothly, and only when
  // the reader is at the bottom. Rows that grow afterwards (images, file cards) keep the view pinned there.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !chat) return;
    // An older page went on top: the replies on screen stay where they were.
    if (anchor.current !== null) { el.scrollTo({ top: el.scrollHeight - anchor.current, behavior: "instant" }); anchor.current = null; return; }
    const toBottom = () => el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    const last = messages.at(-1), mine = last?.senderId === me && last.sequence > newest.current;
    newest.current = Math.max(newest.current, last?.sequence ?? 0);
    if (!settled.current) {
      if (!messages.length && !root) return;
      settled.current = true;
      const target = focus ? el.querySelector<HTMLElement>(`[data-message="${focus.id}"]`) : null;
      if (target) {
        atBottom.current = false; target.scrollIntoView({ block: "center" });
        if (focus?.passage && highlightPassage(target, focus.passage)) return;
        target.classList.add("jv-jump"); setTimeout(() => target.classList.remove("jv-jump"), 1600); return;
      }
      toBottom(); requestAnimationFrame(toBottom);
    } else if (atBottom.current || mine) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    if (atBottom.current || mine) seen.current = last?.sequence ?? 0;
  }, [messages, root, chat]);
  // The same reply asked for again while this pane is open (a quote tag pressed twice): land on it again.
  useEffect(() => { if (settled.current && focus) jump(focus.id, focus.passage); }, [focus]);
  // Near the top of the replies: load the page before. Re-armed after each page, so a short page keeps filling the view.
  useEffect(() => {
    const el = body.current, sentinel = top.current;
    if (!el || !sentinel || !hasOlder || !settled.current) return;
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting && settled.current) void loadOlder(); }, { root: el, rootMargin: "400px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlder, messages, threadId, chat]);
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
  /** Marks and replies work here as in the main view. */
  const react = async (message: ChatMessage, emoji: string, on: boolean) => {
    try {
      const updated = await api.react(message.id, emoji, on);
      const apply = (item: ChatMessage) => item.id === updated.id ? { ...item, reactions: updated.reactions } : item;
      setMessages(previous => previous.map(apply)); setRoot(previous => previous && apply(previous));
    } catch (error) { onError(error); }
  };
  const fold = async (message: ChatMessage, folded: boolean) => {
    try {
      const updated = await api.fold(message.id, folded);
      const apply = (item: ChatMessage) => item.id === updated.id ? { ...item, folded: updated.folded } : item;
      setMessages(previous => previous.map(apply)); setRoot(previous => previous && apply(previous));
    } catch (error) { onError(error); }
  };
  /** A quoted reply: scrolled to, after loading the replies from it on when it is further back than what is loaded. */
  const jump = (id: string | null, passage?: string) => {
    const find = () => id ? body.current?.querySelector<HTMLElement>(`[data-message="${id}"]`) : null, element = find();
    if (element) { jumpToPassage(element, passage); return; }
    if (!id) { onNotice(t("app.sourceGone")); return; }
    void around(id).then(page => {
      if (!page) { onNotice(t("thread.sourceElsewhere")); return; }
      take(page); requestAnimationFrame(() => { const loaded = find(); if (loaded) jumpToPassage(loaded, passage); });
    });
  };
  const actions = { onQuote: (message: ChatMessage) => quoteMessage(drafts, message, members), onReact: react, onFold: fold, onJump: jump, onError };
  /** Replies stay in the thread; only the conclusion is also posted to the channel. */
  const send = async (content: string, attachmentIds: string[], key: string, replyTo?: string, quotes: { messageId: string; text: string }[] = [], alsoToChannel = false) => {
    const sent = await api.send(threadId, content, attachmentIds, key, alsoToChannel, replyTo, quotes);
    const outside = channel ? [...new Set(findMentions(content, liveMembers(members)).filter(hit => !channel.memberIds.includes(hit.member.id)).map(hit => hit.member.name))] : [];
    if (outside.length) onNotice(t("app.notInChannel", { names: outside.join(t("common.listSeparator")), count: outside.length }));
    // In the thread at once; the thread's row comes with the event for it (A72).
    place(sent);
  };
  const channelName = channel?.title ?? t("search.channel"), rootSender = members.find(member => member.id === root?.senderId);
  const unseen = away ? messages.filter(message => message.sequence > seen.current && message.senderId !== me).length : 0;
  const Shell = mode === "pane" ? "aside" : mode === "embed" ? "section" : "main";
  // Who takes part in the thread, first in its @ list: the root's author, whoever replied, and whoever was @-ed in it.
  const participants = new Set([...(root ? [root.senderId, ...root.mentions] : []), ...messages.flatMap(message => [message.senderId, ...message.mentions])]);
  participants.delete(me);
  return <Shell className={mode === "pane" ? "ui-pane jv-pane" : mode === "embed" ? "ui-chat jv-thread-full jv-thread-embed" : "ui-chat jv-thread-full"} aria-label={t("thread.label")}
    onKeyDown={event => { if (chat && onSearch && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); onSearch(chat); } }}>
    <header className={mode === "pane" ? "ui-pane-header jv-pane-header" : "ui-chat-header jv-pane-header"}>
      {mode === "full" && <IconButton icon="layout-sidebar-left" className="ui-mobile-only" label={t("common.openNav")} onClick={onNav}/>}
      {mode === "embed" && <IconButton icon="chevron-left" className="ui-mobile-only" label={t("thread.backToList")} onClick={onClose}/>}
      {mode === "full" ? <button type="button" className="jv-crumb" onClick={onClose}><Icon name="chevron-left"/><span className="jv-hash">#</span>{channelName}</button>
        : mode === "embed" ? <button type="button" className="jv-crumb" title={t("thread.inChannel")} onClick={onToggleMode}><span className="jv-hash">#</span>{channelName}</button>
        : <><strong>{t("thread.label")}</strong><span className="jv-muted jv-pane-sub">#{channelName}</span></>}
      <span className="jv-spacer"/>
      {chat && onSearch && <IconButton icon="search" label={t("thread.search")} onClick={() => onSearch(chat)}/>}
      {chat && <button type="button" className="ui-button jv-follow" data-on={chat.following || undefined} title={t(chat.following ? "thread.followingHint" : "thread.notFollowingHint")}
        onClick={() => void save(() => api.follow(threadId, !chat.following)).catch(() => {})}><Icon name="bell"/>{t(chat.following ? "threads.following" : "thread.follow")}</button>}
      {mode !== "embed" && <IconButton icon={mode === "pane" ? "arrows-expand" : "arrows-contract"} className="jv-desktop-only" label={t(mode === "pane" ? "thread.expand" : "thread.collapse")} onClick={onToggleMode}/>}
      {mode === "pane" && <IconButton icon="close" label={t("thread.close")} onClick={onClose}/>}
    </header>
    {chat && <div className={mode === "pane" ? "jv-thread-pin" : "jv-thread-pin jv-thread-pin-wide"}><ThreadMeta chat={chat} channelName={channelName} expanded={showSummary}
        onTitle={title => save(() => api.updateThread(threadId, { title }))} onStatus={status => save(() => api.updateThread(threadId, { status }))}
        onSummary={text => save(() => api.setNote(threadId, text))}
        onConclude={async () => {
          try {
            await send(`${t("thread.conclusion")}\n\n${chat.note?.text ?? ""}`, [], Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""), undefined, [], true);
            await save(() => api.updateThread(threadId, { status: "done" }));
            onNotice(t("thread.concluded", { channel: channelName }));
          } catch (error) { onError(error); throw error; }
        }}/></div>}
    <div ref={body} className={mode === "pane" ? "ui-pane-body jv-pane-body" : "ui-transcript jv-thread-wide"}>
      <div ref={rows}>
      {root && <ChannelMessages messages={[{ ...root, thread: null }]} members={members} bots={bots} me={me} divider={Number.MAX_SAFE_INTEGER}
        onSettled={() => {}} onPreview={onPreview} onReact={react} onFold={fold} onJump={jump} onError={onError}/>}
      <div className="jv-divider" data-tone="count" role="separator"><span>{messages.length ? t("channel.replies", { count: root?.thread?.replies ?? messages.length }) : t("thread.noReplies")}</span></div>
      {hasOlder && <div ref={top} className="jv-history-more" aria-live="polite">{loadingOlder ? t("chat.loadingOlder") : ""}</div>}
      <ChannelMessages messages={messages} members={members} bots={bots} me={me} divider={divider ?? Number.MAX_SAFE_INTEGER} before={root?.createdAt}
        onSettled={updated => setMessages(previous => previous.map(item => item.id === updated.id ? updated : item))} onPreview={onPreview} {...actions}/>
      </div>
      {away && messages.length > 0 && <div className="jv-to-latest"><button type="button" aria-label={t("thread.toLatest")}
        onClick={() => body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" })}>
        {unseen > 0 && <span>{t("chat.unseen", { count: unseen })}</span>}<Icon name="chevron-down"/></button></div>}
    </div>
    <Composer chatId={threadId} id="jarvy-thread-composer" drafts={drafts} placeholder={t("thread.reply")} scrollRef={body} disabled={!chat}
      initialText={messages.length === 0 && root && root.senderId !== me && rootSender && !rootSender.deleted ? `@${rootSender.name} ` : undefined}
      mention={{ bots, inside: liveMembers(members).filter(member => member.id !== me && !!channel?.memberIds.includes(member.id)),
        outside: liveMembers(members).filter(member => !channel?.memberIds.includes(member.id)), onInvite, participants }}
      onSend={send} onError={onError} onNotice={onNotice}/>
    {/* Passages go into this thread's draft; the root can be quoted too (A44). */}
    <QuoteSelection container={body} drafts={drafts} chatId={threadId} members={members} onNotice={onNotice}
      source={id => id === root?.id ? root : messages.find(message => message.id === id)}/>
  </Shell>;
}
