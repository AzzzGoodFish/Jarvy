import { useEffect, useRef, useState, type ReactNode } from "react";
import { type Bot } from "../../contract/bots";
import { type Chat, type Member } from "../../contract/chat";
import type { FollowedSummary, ThreadFilter, ThreadItem } from "../../contract/threads";
import { formatDate, t } from "../i18n";
import { previewText } from "../channel/quotes";
import { IconButton } from "../ui";
import { Button } from "../components/ui/button";
import { MemberAvatar } from "../channel/ChannelView";
import { ThreadSortSelect, useThreadSort } from "./sort";
import { useFollowedThreads, type ThreadEvents } from "./followed";

const when = (time: number) => formatDate(time, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const EMPTY = { all: "threads.none", unread: "threads.noneUnread", open: "threads.noneOpen", done: "threads.noneDone" } as const;

/** 「我关注的线程」 (A37 P2, A69): threads you started, replied in, were @-mentioned in or followed by hand, beside the
 * selected thread, loaded a page at a time as you scroll. The tabs and the order are applied by the server; their
 * numbers come with the chat list. Reading a thread in 未读 takes it out of the list while its pane stays; a thread
 * unfollowed here stays, marked, until you leave the page.
 * Phones show one column. */
export function FollowedThreads({ events, summary, chats, members, bots, onNav, renderThread }: {
  events: ThreadEvents; summary: FollowedSummary | null; chats: Chat[]; members: Member[]; bots: Bot[]; onNav: () => void;
  renderThread: (thread: ThreadItem, back: () => void) => ReactNode;
}) {
  // The picked thread stays open across tabs and orders, whether or not their pages hold it.
  const [picked, setPicked] = useState<ThreadItem | null>(null), [tab, setTab] = useState<ThreadFilter>("all");
  const [sort, setSort] = useThreadSort("followed");
  const list = useFollowedThreads(events, tab, sort), current = picked ? list.find(picked.id) ?? picked : undefined;
  // Near the end: the next page. Re-armed after each page, so a short page keeps filling the view.
  const scroller = useRef<HTMLDivElement>(null), end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scroller.current || !end.current || !list.more || list.loading || list.failed) return;
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) list.loadMore(); }, { root: scroller.current, rootMargin: "0px 0px 400px 0px" });
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [list.more, list.loading, list.failed, list.items]);
  const tabs: [ThreadFilter, string][] = [["all", t("threads.all")], ["unread", summary?.unreadThreads ? t("threads.unreadCount", { count: summary.unreadThreads }) : t("threads.unread")],
    ["open", t("threads.openCount", { count: summary?.open ?? 0 })], ["done", t("threads.doneCount", { count: summary?.done ?? 0 })]];
  return <main className="ui-chat jv-followed-page" aria-label={t("sidebar.followed")} data-open={current ? "" : undefined}>
    <section className="jv-followed-list" aria-label={t("threads.list")}>
      <header className="ui-chat-header jv-channel-header"><div className="ui-header-left">
        <IconButton icon="layout-sidebar-left" className="ui-mobile-only" label={t("common.openNav")} onClick={onNav}/>
        <strong className="jv-channel-title">{t("sidebar.followed")}</strong></div>
        <ThreadSortSelect value={sort} onChange={setSort}/></header>
      <div className="jv-tabs" role="tablist" aria-label={t("threads.filter")}>
        {tabs.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}
      </div>
      <div className="jv-followed-items" ref={scroller}>
        {list.ready && list.items.length === 0 && !list.more ? <p className="jv-picker-empty">{t(EMPTY[tab])}</p> : list.items.map(thread => {
          const sender = members.find(member => member.id === thread.root?.senderId), channel = chats.find(chat => chat.id === thread.parentId);
          return <button key={thread.id} type="button" className="jv-thread-item" data-unread={thread.unread > 0 || undefined}
            aria-current={thread.id === picked?.id || undefined} onClick={() => setPicked(thread)}>
            <span className="jv-thread-item-head"><strong>{thread.title}</strong>
              {thread.alerts > 0 ? <span className="jv-badge">{thread.alerts}</span> : thread.unread > 0 && <span className="jv-count">{thread.unread}</span>}
              <span className="jv-thread-status" data-done={thread.status === "done" || undefined}>{t(thread.status === "done" ? "channel.threadDone" : "threads.open")}</span></span>
            {thread.root && <span className="jv-thread-item-root"><MemberAvatar member={sender} bots={bots} size={16}/><span>{previewText(thread.root)}</span></span>}
            <span className="jv-muted jv-thread-item-meta">#{channel?.title ?? ""} · {t("channel.replies", { count: thread.replies })}{thread.lastReplyAt ? ` · ${when(thread.lastReplyAt)}` : ""}{thread.following ? "" : ` · ${t("threads.notFollowing")}`}</span>
          </button>;
        })}
        <div ref={end} className="jv-followed-end">
          {list.failed ? <><p role="alert">{t("threads.loadFailed")}</p><Button variant="outline" size="sm" onClick={list.retry}>{t("common.retry")}</Button></>
            : (list.loading || !list.ready) && <p role="status">{t("threads.loading")}</p>}
        </div>
      </div>
    </section>
    {current ? renderThread(current, () => setPicked(null)) : <div className="jv-followed-empty"><p>{t("threads.pick")}</p></div>}
  </main>;
}
