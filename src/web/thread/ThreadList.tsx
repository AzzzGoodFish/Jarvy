import { useEffect, useState } from "react";
import { api, type Bot, type Chat, type Member, type ThreadEntry } from "../api";
import { IconButton } from "../ui";
import { MemberAvatar } from "../channel/ChannelView";

/** List previews show plain text: Markdown marks dropped, first lines only. */
const plain = (text: string) => text.replace(/[*`~#>]/g, "").replace(/\s+/g, " ").trim();
const when = (time: number) => new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A channel's threads (A37): open / done / all, most recently active first. */
export function ThreadList({ channel, members, bots, tick, onOpen, onClose, onError }: {
  channel: Chat; members: Member[]; bots: Bot[]; tick: number;
  onOpen: (threadId: string) => void; onClose: () => void; onError: (error: unknown) => void;
}) {
  const [threads, setThreads] = useState<ThreadEntry[] | null>(null), [tab, setTab] = useState<"open" | "done" | "all">("open");
  useEffect(() => {
    let alive = true;
    void api.channelThreads(channel.id).then(result => { if (alive) setThreads(result.threads); }).catch(error => { if (alive) onError(error); });
    return () => { alive = false; };
  }, [channel.id, tick]);
  const shown = (threads ?? []).filter(thread => tab === "all" || thread.status === tab);
  const count = (status: "open" | "done") => (threads ?? []).filter(thread => thread.status === status).length;
  return <aside className="ui-pane jv-pane" aria-label="线程列表">
    <header className="ui-pane-header jv-pane-header"><strong>线程</strong><span className="jv-muted jv-pane-sub">#{channel.title}</span><span className="jv-spacer"/>
      <IconButton icon="close" label="关闭线程列表" onClick={onClose}/></header>
    <div className="jv-tabs" role="tablist" aria-label="按状态筛选">
      {([["open", `进行中 ${count("open")}`], ["done", `已完成 ${count("done")}`], ["all", "全部"]] as const).map(([value, label]) =>
        <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}
    </div>
    <div className="ui-pane-body jv-pane-body">
      {threads === null ? <p className="jv-picker-empty">正在读取…</p> : shown.length === 0 ? <p className="jv-picker-empty">暂无线程</p>
        : shown.map(thread => {
          const sender = members.find(member => member.id === thread.root?.senderId);
          return <button key={thread.id} type="button" className="jv-thread-item" data-unread={thread.unread > 0 || undefined} onClick={() => onOpen(thread.id)}>
            <span className="jv-thread-item-head"><strong>{thread.title}</strong>
              {thread.alerts > 0 ? <span className="jv-badge">{thread.alerts}</span> : thread.unread > 0 && <span className="jv-count">{thread.unread}</span>}
              <span className="jv-status" data-done={thread.status === "done" || undefined}>{thread.status === "done" ? "已完成" : "进行中"}</span></span>
            {thread.root && <span className="jv-thread-item-root"><MemberAvatar member={sender} bots={bots} size={16}/><span>{plain(thread.root.content)}</span></span>}
            <span className="jv-muted jv-thread-item-meta">{thread.replies} 条回复{thread.lastReplyAt ? ` · ${when(thread.lastReplyAt)}` : ""}{thread.following ? " · 已关注" : ""}</span>
          </button>;
        })}
    </div>
  </aside>;
}

/** 「我关注的线程」 (A37 P2): threads you started, replied in, were @-mentioned in or followed by hand; unread first. */
export function FollowedThreads({ threads, chats, members, bots, onOpen, onNav }: {
  threads: ThreadEntry[]; chats: Chat[]; members: Member[]; bots: Bot[]; onOpen: (thread: ThreadEntry) => void; onNav: () => void;
}) {
  const list = [...threads].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || (b.lastReplyAt ?? 0) - (a.lastReplyAt ?? 0));
  return <main className="ui-chat" aria-label="我关注的线程">
    <header className="ui-chat-header jv-channel-header"><div className="ui-header-left">
      <IconButton icon="layout-sidebar-left" className="ui-mobile-only" label="打开会话列表" onClick={onNav}/>
      <strong className="jv-channel-title">我关注的线程</strong></div></header>
    <div className="ui-transcript jv-followed">
      {list.length === 0 ? <p className="jv-picker-empty">暂无线程</p> : list.map(thread => {
        const sender = members.find(member => member.id === thread.root?.senderId), channel = chats.find(chat => chat.id === thread.parentId);
        return <button key={thread.id} type="button" className="jv-thread-item" data-unread={thread.unread > 0 || undefined} onClick={() => onOpen(thread)}>
          <span className="jv-thread-item-head"><strong>{thread.title}</strong>
            {thread.alerts > 0 ? <span className="jv-badge">{thread.alerts}</span> : thread.unread > 0 && <span className="jv-count">{thread.unread}</span>}
            <span className="jv-status" data-done={thread.status === "done" || undefined}>{thread.status === "done" ? "已完成" : "进行中"}</span></span>
          {thread.root && <span className="jv-thread-item-root"><MemberAvatar member={sender} bots={bots} size={16}/><span>{plain(thread.root.content)}</span></span>}
          <span className="jv-muted jv-thread-item-meta">#{channel?.title ?? ""} · {thread.replies} 条回复{thread.lastReplyAt ? ` · ${when(thread.lastReplyAt)}` : ""}</span>
        </button>;
      })}
    </div>
  </main>;
}
