import { useEffect, useState, type ReactNode } from "react";
import { api, type Bot, type Chat, type Member, type ThreadEntry } from "../api";
import { formatDate, t } from "../i18n";
import { previewText } from "../channel/quotes";
import { IconButton } from "../ui";
import { MemberAvatar } from "../channel/ChannelView";
import { sortThreads, ThreadSortSelect, useThreadSort } from "./sort";

const when = (time: number) => formatDate(time, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A channel's threads (A37): open / done / all, in the order picked in the header (newest activity by default). */
export function ThreadList({ channel, members, bots, tick, onOpen, onClose, onError }: {
  channel: Chat; members: Member[]; bots: Bot[]; tick: number;
  onOpen: (threadId: string) => void; onClose: () => void; onError: (error: unknown) => void;
}) {
  const [threads, setThreads] = useState<ThreadEntry[] | null>(null), [tab, setTab] = useState<"open" | "done" | "all">("open");
  const [sort, setSort] = useThreadSort("channel");
  useEffect(() => {
    let alive = true;
    void api.channelThreads(channel.id).then(result => { if (alive) setThreads(result.threads); }).catch(error => { if (alive) onError(error); });
    return () => { alive = false; };
  }, [channel.id, tick]);
  const shown = sortThreads((threads ?? []).filter(thread => tab === "all" || thread.status === tab), sort);
  const count = (status: "open" | "done") => (threads ?? []).filter(thread => thread.status === status).length;
  return <aside className="ui-pane jv-pane" aria-label={t("threads.list")}>
    <header className="ui-pane-header jv-pane-header"><strong>{t("channel.threads")}</strong><span className="jv-muted jv-pane-sub">#{channel.title}</span><span className="jv-spacer"/>
      <ThreadSortSelect value={sort} onChange={setSort}/>
      <IconButton icon="close" label={t("threads.closeList")} onClick={onClose}/></header>
    <div className="jv-tabs" role="tablist" aria-label={t("threads.byStatus")}>
      {([["open", t("threads.openCount", { count: count("open") })], ["done", t("threads.doneCount", { count: count("done") })], ["all", t("threads.all")]] as const).map(([value, label]) =>
        <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}
    </div>
    <div className="ui-pane-body jv-pane-body">
      {threads === null ? <p className="jv-picker-empty">{t("threads.loading")}</p> : shown.length === 0 ? <p className="jv-picker-empty">{t("threads.none")}</p>
        : shown.map(thread => {
          const sender = members.find(member => member.id === thread.root?.senderId);
          return <button key={thread.id} type="button" className="jv-thread-item" data-unread={thread.unread > 0 || undefined} onClick={() => onOpen(thread.id)}>
            <span className="jv-thread-item-head"><strong>{thread.title}</strong>
              {thread.alerts > 0 ? <span className="jv-badge">{thread.alerts}</span> : thread.unread > 0 && <span className="jv-count">{thread.unread}</span>}
              <span className="jv-thread-status" data-done={thread.status === "done" || undefined}>{t(thread.status === "done" ? "channel.threadDone" : "threads.open")}</span></span>
            {thread.root && <span className="jv-thread-item-root"><MemberAvatar member={sender} bots={bots} size={16}/><span>{previewText(thread.root)}</span></span>}
            <span className="jv-muted jv-thread-item-meta">{t("channel.replies", { count: thread.replies })}{thread.lastReplyAt ? ` · ${when(thread.lastReplyAt)}` : ""}{thread.following ? ` · ${t("threads.following")}` : ""}</span>
          </button>;
        })}
    </div>
  </aside>;
}

/** 「我关注的线程」 (A37 P2): threads you started, replied in, were @-mentioned in or followed by hand, newest reply first,
 * beside the selected thread, in the order picked in the header. A thread you unfollow stays until you leave the page; the
 * 未读 tab lists only what is still unread, so reading one takes it out while the pane keeps showing it; 进行中 / 已完成
 * filter by status.
 * Phones show one column. */
export function FollowedThreads({ threads, chats, members, bots, onNav, renderThread }: {
  threads: ThreadEntry[]; chats: Chat[]; members: Member[]; bots: Bot[]; onNav: () => void;
  renderThread: (thread: ThreadEntry, back: () => void) => ReactNode;
}) {
  const [shown, setShown] = useState(threads), [selected, setSelected] = useState<string | null>(null), [tab, setTab] = useState<"all" | "unread" | "open" | "done">("all");
  const [sort, setSort] = useThreadSort("followed");
  useEffect(() => setShown(previous => [
    ...threads, ...previous.filter(old => !threads.some(thread => thread.id === old.id)).map(old => ({ ...old, following: false, unread: 0, alerts: 0 })),
  ]), [threads]);
  const list = sortThreads(shown, sort).filter(thread => tab === "all" || (tab === "unread" ? thread.unread > 0 : thread.status === tab));
  const unread = shown.filter(thread => thread.unread > 0).length, current = shown.find(thread => thread.id === selected);
  const count = (status: "open" | "done") => shown.filter(thread => thread.status === status).length;
  return <main className="ui-chat jv-followed-page" aria-label={t("sidebar.followed")} data-open={current ? "" : undefined}>
    <section className="jv-followed-list" aria-label={t("threads.list")}>
      <header className="ui-chat-header jv-channel-header"><div className="ui-header-left">
        <IconButton icon="layout-sidebar-left" className="ui-mobile-only" label={t("common.openNav")} onClick={onNav}/>
        <strong className="jv-channel-title">{t("sidebar.followed")}</strong></div>
        <ThreadSortSelect value={sort} onChange={setSort}/></header>
      <div className="jv-tabs" role="tablist" aria-label={t("threads.filter")}>
        {([["all", t("threads.all")], ["unread", unread ? t("threads.unreadCount", { count: unread }) : t("threads.unread")], ["open", t("threads.openCount", { count: count("open") })], ["done", t("threads.doneCount", { count: count("done") })]] as const).map(([value, label]) =>
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}
      </div>
      <div className="jv-followed-items">
        {list.length === 0 ? <p className="jv-picker-empty">{t(({ all: "threads.none", unread: "threads.noneUnread", open: "threads.noneOpen", done: "threads.noneDone" } as const)[tab])}</p> : list.map(thread => {
          const sender = members.find(member => member.id === thread.root?.senderId), channel = chats.find(chat => chat.id === thread.parentId);
          return <button key={thread.id} type="button" className="jv-thread-item" data-unread={thread.unread > 0 || undefined}
            aria-current={thread.id === selected || undefined} onClick={() => setSelected(thread.id)}>
            <span className="jv-thread-item-head"><strong>{thread.title}</strong>
              {thread.alerts > 0 ? <span className="jv-badge">{thread.alerts}</span> : thread.unread > 0 && <span className="jv-count">{thread.unread}</span>}
              <span className="jv-thread-status" data-done={thread.status === "done" || undefined}>{t(thread.status === "done" ? "channel.threadDone" : "threads.open")}</span></span>
            {thread.root && <span className="jv-thread-item-root"><MemberAvatar member={sender} bots={bots} size={16}/><span>{previewText(thread.root)}</span></span>}
            <span className="jv-muted jv-thread-item-meta">#{channel?.title ?? ""} · {t("channel.replies", { count: thread.replies })}{thread.lastReplyAt ? ` · ${when(thread.lastReplyAt)}` : ""}{thread.following ? "" : ` · ${t("threads.notFollowing")}`}</span>
          </button>;
        })}
      </div>
    </section>
    {current ? renderThread(current, () => setSelected(null)) : <div className="jv-followed-empty"><p>{t("threads.pick")}</p></div>}
  </main>;
}
