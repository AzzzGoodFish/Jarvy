import { useState } from "react";
import { Ellipsis, Pin, Search } from "lucide-react";
import type { MenuTarget } from "./EntryMenu";
import type { Bot, Chat, Member, Section, ThreadEntry } from "../api";
import { ResultGroup, SearchResults } from "../search/SearchResults";
import { BotAvatar } from "../avatar/BotAvatar";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { ScrollArea } from "../components/ui/scroll-area";
import { formatClock, t } from "../i18n";
import { Icon } from "../ui";

const COLLAPSED_KEY = "jarvy-collapsed-sections";
const savedCollapsed = (): string[] => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]; } catch { return []; } };

/** Unread @-mentions (every unread DM message) as a filled badge; other unread as bold + count. */
/** Red: delivered to you and unread (DMs, @, replies); grey: other unread (A41). */
export function Badge({ chat }: { chat: Chat }) {
  if (chat.alerts > 0) return <span className="jv-badge" aria-label={t("sidebar.alerts", { count: chat.alerts })}>{chat.alerts}</span>;
  if (chat.unread > 0) return <span className="jv-count" aria-label={t("sidebar.unread", { count: chat.unread })}>{chat.unread}</span>;
  return null;
}
/** The hint line for a queued delivery you have not seen (a mark on your message, a new notice / summary), worded
 * like Feishu. The small line shows whatever happened last, so a newer message replaces it. */
export function hintText(chat: Chat): string | null {
  const hint = chat.hint;
  if (!hint || hint.createdAt < chat.updatedAt - 1000) return null;
  // On a channel row, a thread's hint names the thread, and opening the row opens it (hintThread).
  const elsewhere = hint.chatType === "thread" && hint.chatId !== chat.id;
  const vars = { actor: hint.actor, emoji: hint.detail, title: hint.title.length > 16 ? `${hint.title.slice(0, 16)}…` : hint.title };
  if (hint.kind === "reaction") return t(elsewhere ? "hint.reactionInThread" : "hint.reaction", vars);
  return t(elsewhere ? "hint.threadSummary" : hint.chatType === "thread" ? "hint.summary" : "hint.notice", vars);
}
/** The thread a channel row's showing hint is about, so opening the row can open that thread with it. */
export function hintThread(chat: Chat): string | null {
  return chat.type === "channel" && hintText(chat) && chat.hint?.chatType === "thread" && chat.hint.chatId !== chat.id ? chat.hint.chatId : null;
}
/** A row's second line, as in Feishu: the newest thing — a hint, or the last message (channels add
 * who wrote it) — after a red 「[有人@我]」 while an @ or a reply to you is unread. */
function Digest({ chat, channel }: { chat: Chat; channel: boolean }) {
  const hint = hintText(chat);
  const text = hint ?? (chat.lastMessage ? (channel && chat.lastSender ? t("sidebar.said", { name: chat.lastSender, text: chat.lastMessage }) : chat.lastMessage) : channel ? chat.topic : "");
  return <span className="jv-digest">{chat.atMe && <span className="jv-at-me">{t("sidebar.atMe")}</span>}<span className={hint ? "jv-hint-line" : undefined}>{text}</span></span>;
}

/** Channel groups (Section) with their channels, ungrouped channels under 「频道」, then one DM row per Bot
 * (A37; one DM per pair). Every group folds. Channel rows are compact; DM rows keep the
 * avatar, time and last message. */
/** Opens a row menu under its 「…」 button, right-aligned with it. */
const below = (button: HTMLElement) => { const rect = button.getBoundingClientRect(); return { x: rect.right - 168, y: rect.bottom + 4 }; };

export function Sidebar({ chats, sections, bots, members, onOpenMessage, onOpenFound, onError, working, asking, selected, filter, followed, followedOpen, onFilterChange, onSelect, onOpenBot, onOpenFollowed, onMenu, onEditSection }: {
  chats: Chat[]; sections: Section[]; bots: Bot[]; members: Member[];
  /** Search (when the box has text): a message found opens where it is; a channel or thread found opens beside its channel. */
  onOpenMessage: (chat: Chat, messageId: string) => void; onOpenFound: (chat: Chat) => void; onError: (error: unknown) => void;
  /** Bots whose agent is running right now; their DM rows show the typing dots. */
  working: Set<string>;
  /** Bots waiting for an answer to a question (messages.ask); their DM rows show a question mark. */
  asking: Set<string>;
  selected: string | null; filter: string;
  /** Threads you follow (A37 P2): one entry at the top with their unread total, opening the list. */
  followed: ThreadEntry[]; followedOpen: boolean; onOpenFollowed: () => void;
  onFilterChange: (value: string) => void; onSelect: (chat: Chat) => void; onOpenBot: (bot: Bot) => void;
  /** The row's 「…」 menu, also opened by right-click. */
  /** `at` is where the menu opens: the pointer for a right-click, under the 「…」 button otherwise. */
  onMenu: (target: MenuTarget, at: { x: number; y: number }) => void;
  onEditSection: (section: Section) => void;
}) {
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const toggle = (id: string) => setCollapsed(previous => {
    const next = previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id];
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    return next;
  });
  const query = filter.toLocaleLowerCase();
  // Searching, chats match by name and topic; their messages are found by the server (SearchResults).
  const visible = chats.filter(chat => chat.type !== "thread" && `${chat.title} ${chat.topic} ${bots.find(bot => bot.id === chat.botId)?.name ?? ""}`
    .toLocaleLowerCase().includes(query));
  const threadUnread = followed.reduce((sum, thread) => sum + thread.unread, 0), threadMentions = followed.reduce((sum, thread) => sum + thread.mentions, 0);
  // Pinned chats come first within their own group.
  const channels = visible.filter(chat => chat.type === "channel").sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title, "zh-CN"));
  // Channel names are data, not interface text: they sort the Chinese-aware way (by pinyin) in either language.
  // A Bot's DM is its most recent one (older data may hold several); Bots without a DM come last.
  const dms = bots.map(bot => ({ bot, chat: chats.find(chat => chat.type === "dm" && chat.botId === bot.id) }))
    .filter(({ bot }) => bot.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(!!b.chat?.pinned) - Number(!!a.chat?.pinned) || (b.chat?.updatedAt ?? 0) - (a.chat?.updatedAt ?? 0));
  const channelRow = (chat: Chat) => <div className="jv-side-wrap" key={chat.id}
    onContextMenu={event => { event.preventDefault(); onMenu({ kind: "channel", chat }, { x: event.clientX, y: event.clientY }); }}>
    <button type="button" className="jv-side-row" data-active={selected === chat.id || undefined}
      data-unread={chat.unread > 0 || undefined} aria-current={selected === chat.id ? "page" : undefined} onClick={() => onSelect(chat)}>
      {chat.pinned ? <Pin className="jv-side-pin" aria-label={t("sidebar.pinned")}/> : <span className="jv-hash" aria-hidden="true">#</span>}
      <span className="jv-side-text">
        <span className="jv-side-line"><span className="jv-side-label" title={chat.title}>{chat.title}</span>
          {chat.muted && <span className="jv-side-muted" aria-label={t("sidebar.muted")}><Icon name="bell-slash"/></span>}</span>
        <span className="jv-side-line"><Digest chat={chat} channel/><Badge chat={chat}/></span>
      </span>
    </button>
    <button type="button" className="jv-side-more" aria-label={t("sidebar.more", { name: chat.title })} onClick={event => onMenu({ kind: "channel", chat }, below(event.currentTarget))}><Ellipsis aria-hidden="true"/></button>
  </div>;
  const dmRow = ({ bot, chat }: { bot: Bot; chat: Chat | undefined }) => {
    const badge = asking.has(bot.id) ? "asking" : working.has(bot.id) ? "working" : undefined, active = !!chat && selected === chat.id;
    return <div className="shadcn-chat-row relative" key={bot.id}
      onContextMenu={event => { event.preventDefault(); onMenu({ kind: "dm", bot, chat }, { x: event.clientX, y: event.clientY }); }}>
      <Button type="button" variant="ghost" data-active={active} aria-current={active ? "page" : undefined}
        className="h-15 w-full justify-start gap-2.5 rounded-md px-2 text-left hover:bg-accent/70 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
        onClick={() => chat ? onSelect(chat) : onOpenBot(bot)}>
        <BotAvatar color={bot.color} mood={bot.mood} size={36} badge={badge}/>
        {badge && <span className="sr-only">{t(badge === "asking" ? "sidebar.asking" : "sidebar.working")}</span>}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`min-w-0 flex-1 truncate text-sm ${chat?.unread ? "font-semibold" : "font-medium"}`} title={bot.name}>{bot.name}</span>
            {chat?.muted && <span className="jv-side-muted" aria-label={t("sidebar.muted")}><Icon name="bell-slash"/></span>}
            {chat?.pinned && <Pin className="jv-dm-pin shrink-0" aria-label={t("sidebar.pinned")}/>}
            {chat && <time className="shadcn-chat-time shrink-0 text-[11px] font-normal text-muted-foreground" dateTime={new Date(chat.updatedAt).toISOString()}>
              {formatClock(chat.updatedAt)}
            </time>}
          </span>
          <span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">{chat ? <Digest chat={chat} channel={false}/> : ""}</span>{chat && <Badge chat={chat}/>}</span>
        </span>
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={t("sidebar.more", { name: bot.name })}
        className="shadcn-chat-more absolute top-4 right-2 opacity-0" onClick={event => onMenu({ kind: "dm", bot, chat }, below(event.currentTarget))}>
        <Ellipsis aria-hidden="true"/>
      </Button>
    </div>;
  };
  // The whole group name folds and unfolds the group, like Discord categories.
  const head = (key: string, label: string, closed: boolean, unread: boolean, section?: Section) => <div className="jv-side-section-head">
    <button type="button" className="jv-side-section-toggle" aria-expanded={!closed} onClick={() => toggle(key)}>
      <span className="jv-side-chevron"><Icon name={closed ? "chevron-right" : "chevron-down"}/></span>
      <span className="jv-side-section-name">{label}{closed && unread && <span className="jv-dot" aria-label={t("sidebar.hasUnread")}/>}</span></button>
    {section && <button type="button" className="jv-side-section-edit" aria-label={t("sidebar.editSection", { name: label })} onClick={() => onEditSection(section)}><Icon name="pencil"/></button>}
  </div>;
  const isClosed = (key: string) => !query && collapsed.includes(key);
  const group = (key: string, label: string, rows: Chat[], section?: Section) => <div className="jv-side-section" key={key}>
    {head(key, label, isClosed(key), rows.some(chat => chat.unread > 0), section)}
    {!isClosed(key) && rows.map(channelRow)}
  </div>;

  return <>
    <div className="mx-3 mt-1 mb-2 shrink-0" role="search">
      <InputGroup className="h-9 bg-background">
        <InputGroupInput id="jarvy-search" type="search" value={filter} onChange={event => onFilterChange(event.target.value)}
          placeholder={t("sidebar.search")} aria-label={t("sidebar.search")}
          onKeyDown={event => { if (event.key === "Escape" && filter) { event.preventDefault(); onFilterChange(""); } }} className="text-sm"/>
        <InputGroupAddon align="inline-start"><Search aria-hidden="true"/></InputGroupAddon>
      </InputGroup>
    </div>
    <ScrollArea className="min-h-0 flex-1" type="auto">
      {query ? <nav className="jv-side-nav jv-side-search px-3 pb-6" aria-label={t("sidebar.results")}>
        <ResultGroup label={t("sidebar.chats")} items={[...channels.map(channelRow), ...dms.map(dmRow)]}/>
        <SearchResults query={filter} shown={new Set(channels.map(chat => chat.id))} chats={chats} members={members}
          onOpenChat={onOpenFound} onOpenMessage={onOpenMessage} onError={onError}/>
      </nav> : <nav className="jv-side-nav px-3 pb-6" aria-label={t("sidebar.nav")}>
        {followed.length > 0 && <button type="button" className="jv-side-row jv-side-top" data-active={followedOpen || undefined} data-unread={threadUnread > 0 || undefined}
          aria-current={followedOpen ? "page" : undefined} onClick={onOpenFollowed}>
          <Icon name="chat-bubble"/><span className="jv-side-label">{t("sidebar.followed")}</span>
          {threadMentions > 0 ? <span className="jv-badge">{threadMentions}</span> : threadUnread > 0 && <span className="jv-count">{threadUnread}</span>}
        </button>}
        {sections.map(section => group(`s:${section.id}`, section.name, channels.filter(chat => chat.sectionId === section.id), section))}
        {channels.some(chat => !chat.sectionId || !sections.some(section => section.id === chat.sectionId)) &&
          group("channels", t("sidebar.channels"), channels.filter(chat => !chat.sectionId || !sections.some(section => section.id === chat.sectionId)))}
        <div className="jv-side-section">
          {head("dms", t("sidebar.dms"), isClosed("dms"), dms.some(({ chat }) => !!chat?.unread))}
          {!isClosed("dms") && <div className="space-y-1">{dms.map(dmRow)}</div>}
          {!isClosed("dms") && dms.length === 0 && <p className="jv-side-empty">{t("sidebar.noDms")}</p>}
        </div>
      </nav>}
    </ScrollArea>
  </>;
}
