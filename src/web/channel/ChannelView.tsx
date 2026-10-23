import { useEffect, useState } from "react";
import type { Attachment, Bot, Chat, ChatMessage, Member } from "../api";
import { BotAvatar } from "../avatar/BotAvatar";
import { FileCards } from "../files/FileCards";
import { QuestionCard } from "../question/QuestionCard";
import { Icon, IconButton, Markdown } from "../ui";
import { MessageText } from "./quotes";
import { MessageActions, ReactionPills, ReplyQuote } from "./MessageActions";
import { memberName } from "../members";
import { formatDate, t } from "../i18n";
import { Clock, DayDivider, shortTime, startsDay, startsGroup } from "./days";

const NOTICE_KEY = "jarvy-notice-closed";
const closedNotices = (): string[] => { try { return JSON.parse(localStorage.getItem(NOTICE_KEY) ?? "[]") as string[]; } catch { return []; } };

export function MemberAvatar({ member, bots, size, working = false }: { member: Member | undefined; bots: Bot[]; size: number; working?: boolean }) {
  const bot = member?.kind === "bot" ? bots.find(item => item.id === member.id) : undefined;
  if (bot) return <BotAvatar color={bot.color} mood={bot.mood} size={size} badge={working ? "working" : undefined} crown={bot.agent}/>;
  return <span className="ui-user-avatar jv-user-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>{(member?.name ?? "?").slice(0, 2).toUpperCase()}</span>;
}

/** Channel header: the name opens channel info, the members button (avatars and count) its member page. */
export function ChannelHeader({ chat, members, bots, infoOpen, membersOpen, threadsOpen, searchOpen, onNav, onInfo, onMembers, onThreads, onSearch }: {
  chat: Chat; members: Member[]; bots: Bot[]; infoOpen: boolean; membersOpen: boolean; threadsOpen: boolean; searchOpen: boolean;
  onNav: () => void; onInfo: () => void; onMembers: () => void; onThreads: () => void; onSearch: () => void;
}) {
  const inside = members.filter(member => chat.memberIds.includes(member.id));
  return <header className="ui-chat-header jv-channel-header">
    <div className="ui-header-left">
      <IconButton icon="layout-sidebar-left" className="ui-mobile-only" label={t("common.openNav")} onClick={onNav}/>
      <button type="button" className="jv-channel-title" aria-label={t("channel.infoFor", { name: chat.title })} aria-pressed={infoOpen} onClick={onInfo}>
        <span className="jv-hash">#</span>{chat.title}<Icon name="chevron-down"/></button>
      {chat.topic && <span className="jv-channel-topic">{chat.topic}</span>}
    </div>
    <div className="ui-header-actions">
      <button type="button" className="jv-members-button" aria-label={t("channel.membersCount", { count: inside.length })} aria-pressed={membersOpen} title={t("channel.members")} onClick={onMembers}>
        <span className="jv-stack">{inside.slice(0, 3).map(member => <span key={member.id} className="jv-stack-item">
          <MemberAvatar member={member} bots={bots} size={22}/></span>)}</span>
        <span className="jv-members-count">{inside.length}</span>
      </button>
      <IconButton icon="search" label={t("channel.search")} aria-pressed={searchOpen} className="jv-threads-button" onClick={onSearch}/>
      <IconButton icon="chat-bubble" label={t("channel.threads")} aria-pressed={threadsOpen} className="jv-threads-button" onClick={onThreads}/>
    </div>
  </header>;
}

/** The channel's notice (A37): folds to one line, anyone in the channel can edit it, version and author shown. */
export function NoticeBar({ chat, onSave }: { chat: Chat; onSave: (text: string) => Promise<void> }) {
  const [closed, setClosed] = useState(closedNotices), [editing, setEditing] = useState<string | null>(null), [saving, setSaving] = useState(false);
  useEffect(() => setEditing(null), [chat.id]);
  const open = !closed.includes(chat.id), note = chat.note;
  const toggle = () => setClosed(previous => {
    const next = open ? [...previous, chat.id] : previous.filter(id => id !== chat.id);
    localStorage.setItem(NOTICE_KEY, JSON.stringify(next)); return next;
  });
  const save = async () => { if (!editing?.trim()) return; setSaving(true); try { await onSave(editing.trim()); setEditing(null); } finally { setSaving(false); } };
  if (editing !== null) return <div className="jv-notice" data-editing>
    <div className="jv-notice-head"><Icon name="megaphone"/><strong>{t("notice.edit")}</strong></div>
    <textarea className="jv-notice-input" value={editing} autoFocus aria-label={t("notice.content")} onChange={event => setEditing(event.target.value)}/>
    <div className="jv-notice-actions"><button type="button" className="ui-button" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
      <button type="button" className="ui-button ui-primary" disabled={saving || !editing.trim()} onClick={() => void save()}>{t("common.save")}</button></div>
  </div>;
  if (!note) return <div className="jv-notice" data-empty><Icon name="megaphone"/><span className="jv-muted">{t("notice.none")}</span>
    <IconButton icon="pencil" label={t("notice.edit")} onClick={() => setEditing("")}/></div>;
  const first = note.text.split("\n").find(line => line.trim() && !line.startsWith("#"))?.replace(/[*`|>-]/g, "").trim() ?? "";
  return <div className="jv-notice" data-open={open || undefined}>
    <div className="jv-notice-head">
      <button type="button" className="jv-notice-toggle" aria-expanded={open} onClick={toggle}><Icon name="megaphone"/><strong>{t("notice.title")}</strong>
        {!open && <span className="jv-notice-first">{first}</span>}<Icon name={open ? "chevron-down" : "chevron-right"}/></button>
      <span className="jv-muted jv-notice-meta">{note.updatedBy.name} · {formatDate(note.updatedAt, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {t("notice.version", { version: note.version })}</span>
      <IconButton icon="pencil" label={t("notice.edit")} onClick={() => setEditing(note.text)}/>
    </div>
    {open && <div className="jv-notice-body ui-bubble jv-flat"><Markdown text={note.text}/></div>}
  </div>;
}

/** Flat, Slack-style rows for channels; consecutive lines from one sender within 5 minutes fold together, and each day
 * opens with a divider. Only the @s that notified someone (stored with the message) are highlighted. `before` is the
 * time of the message shown just above the list (a thread's root), so its day doesn't repeat. */
export function ChannelMessages({ messages, members, bots, me, divider, before, activeQuestion, onSettled, onPreview, onReply, onOpenThread, onQuote, onReact, onJump, onError }: {
  messages: ChatMessage[]; members: Member[]; bots: Bot[]; me: string; divider: number; before?: number; activeQuestion?: string;
  onSettled: (message: ChatMessage) => void; onPreview: (files: Attachment[], index: number) => void;
  /** Channels: reply in the message's thread (opened on first use). Not given inside a thread. */
  onReply?: (message: ChatMessage) => void;
  onOpenThread?: (threadId: string) => void;
  /** Quote this message in the composer. */
  onQuote?: (message: ChatMessage) => void;
  /** Add or remove an emoji mark. */
  onReact?: (message: ChatMessage, emoji: string, on: boolean) => void;
  /** Jump to the message a reply quotes, or to a partial quote's source (null: gone) and its passage. */
  onJump?: (id: string | null, passage?: string) => void;
  onError?: (error: unknown) => void;
}) {
  const firstNew = messages.find(message => message.sequence > divider && message.senderId !== me)?.id;
  return <>{messages.map((message, index) => {
    const previous = messages[index - 1], member = members.find(item => item.id === message.senderId);
    const earlier = previous?.createdAt ?? before;
    const folded = !startsGroup(message, previous, earlier) && message.id !== firstNew;
    return <div key={message.id}>
      {startsDay(message.createdAt, earlier) && <DayDivider time={message.createdAt}/>}
      {message.id === firstNew && <div className="jv-divider" role="separator"><span>{t("chat.newBelow")}</span></div>}
      <div className="jv-row" tabIndex={-1} data-message={message.id} data-folded={folded || undefined} data-mention={message.mentions.includes(me) || undefined}>
        <div className="jv-row-gutter">{folded ? <Clock time={message.createdAt} className="jv-row-time"/> : <MemberAvatar member={member} bots={bots} size={32}/>}</div>
        <div className="jv-row-body">
          {!folded && <div className="jv-row-head"><strong>{memberName(member)}</strong>{member?.kind === "bot" && <span className="jv-role">Bot</span>}<Clock time={message.createdAt}/></div>}
          {message.echoOf && <button type="button" className="jv-echo" onClick={() => onOpenThread?.(message.echoOf!.id)}>{t("channel.echo", { title: message.echoOf.title })}</button>}
          {message.replyTo && <ReplyQuote message={message} members={members} onJump={id => onJump?.(id)}/>}
          {message.question ? <QuestionCard message={{ ...message, question: message.question }} keyboard={message.id === activeQuestion} onSettled={onSettled}/>
            : <div className="ui-bubble jv-flat">{message.content && <MessageText message={message} members={members} me={me} onJump={onJump}/>}
              {message.attachments.length > 0 && <FileCards files={message.attachments} onOpen={file => onPreview(message.attachments, file)}/>}</div>}
          {onReact && <ReactionPills message={message} me={me} members={members} onReact={onReact} onError={onError ?? (() => {})}/>}
          {message.thread && message.thread.replies > 0 && <button type="button" className="jv-thread-link" data-done={message.thread.status === "done" || undefined}
            onClick={() => onOpenThread?.(message.thread!.id)}>{t("channel.replies", { count: message.thread.replies })}{message.thread.status === "done" && ` · ${t("channel.threadDone")}`}
            {message.thread.lastReplyAt && <span className="jv-muted">{t("channel.lastReply", { time: shortTime(message.thread.lastReplyAt) })}</span>}</button>}
        </div>
        <div className="jv-row-actions">
          {onReply && !message.echoOf && <IconButton icon="chat-bubble" label={t("channel.replyInThread")} onClick={() => onReply(message)}/>}
          {onReact && <MessageActions message={message} me={me} onReply={onQuote} onReact={onReact} onError={onError ?? (() => {})}/>}
        </div>
      </div>
    </div>;
  })}</>;
}
