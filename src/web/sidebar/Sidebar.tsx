import { useState } from "react";
import { Ellipsis, Pin, Search } from "lucide-react";
import type { MenuTarget } from "./EntryMenu";
import type { Bot, Chat, Section, ThreadEntry } from "../api";
import { BotAvatar } from "../avatar/BotAvatar";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { ScrollArea } from "../components/ui/scroll-area";
import { Icon } from "../ui";

const COLLAPSED_KEY = "jarvy-collapsed-sections";
const savedCollapsed = (): string[] => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]; } catch { return []; } };

/** Unread @-mentions (every unread DM message) as a filled badge; other unread as bold + count. */
/** Red: delivered to you and unread (DMs, @, replies); grey: other unread (A41). */
export function Badge({ chat }: { chat: Chat }) {
  if (chat.alerts > 0) return <span className="jv-badge" aria-label={`${chat.alerts} 条发给你的未读`}>{chat.alerts}</span>;
  if (chat.unread > 0) return <span className="jv-count" aria-label={`${chat.unread} 条未读`}>{chat.unread}</span>;
  return null;
}
/** The hint line for a queued delivery you have not seen (a mark on your message, a new notice / summary), worded
 * like Feishu. The small line shows whatever happened last, so a newer message replaces it. */
export function hintText(chat: Chat): string | null {
  const hint = chat.hint;
  if (!hint || hint.createdAt < chat.updatedAt - 1000) return null;
  if (hint.kind === "reaction") return `${hint.actor} 对你的消息表达了 ${hint.detail}`;
  return `${hint.actor} 更新了${hint.chatType === "thread" ? "线程摘要" : "公告"}`;
}
/** A row's second line, as in Feishu: the newest thing — a hint, or the last message (channels add
 * who wrote it) — after a red 「[有人@我]」 while an @ or a reply to you is unread. */
function Digest({ chat, channel }: { chat: Chat; channel: boolean }) {
  const hint = hintText(chat);
  const text = hint ?? (chat.lastMessage ? (channel && chat.lastSender ? `${chat.lastSender}：${chat.lastMessage}` : chat.lastMessage) : channel ? chat.topic : "");
  return <span className="jv-digest">{chat.atMe && <span className="jv-at-me">[有人@我]</span>}<span className={hint ? "jv-hint-line" : undefined}>{text}</span></span>;
}

/** Channel groups (Section) with their channels, ungrouped channels under 「频道」, then one DM row per Bot
 * (A37; one DM per pair). Every group folds. Channel rows are compact; DM rows keep the
 * avatar, time and last message. */
/** Opens a row menu under its 「…」 button, right-aligned with it. */
const below = (button: HTMLElement) => { const rect = button.getBoundingClientRect(); return { x: rect.right - 168, y: rect.bottom + 4 }; };

export function Sidebar({ chats, sections, bots, working, asking, selected, filter, followed, followedOpen, onFilterChange, onSelect, onOpenBot, onOpenFollowed, onMenu, onEditSection }: {
  chats: Chat[]; sections: Section[]; bots: Bot[];
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
  const visible = chats.filter(chat => chat.type !== "thread" && `${chat.title} ${chat.topic} ${chat.lastMessage ?? ""} ${bots.find(bot => bot.id === chat.botId)?.name ?? ""}`
    .toLocaleLowerCase().includes(query));
  const threadUnread = followed.reduce((sum, thread) => sum + thread.unread, 0), threadMentions = followed.reduce((sum, thread) => sum + thread.mentions, 0);
  // Pinned chats come first within their own group.
  const channels = visible.filter(chat => chat.type === "channel").sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title, "zh-CN"));
  // A Bot's DM is its most recent one (older data may hold several); Bots without a DM come last.
  const dms = bots.map(bot => ({ bot, chat: chats.find(chat => chat.type === "dm" && chat.botId === bot.id) }))
    .filter(({ bot, chat }) => `${bot.name} ${chat?.lastMessage ?? ""}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(!!b.chat?.pinned) - Number(!!a.chat?.pinned) || (b.chat?.updatedAt ?? 0) - (a.chat?.updatedAt ?? 0));
  const channelRow = (chat: Chat) => <div className="jv-side-wrap" key={chat.id}
    onContextMenu={event => { event.preventDefault(); onMenu({ kind: "channel", chat }, { x: event.clientX, y: event.clientY }); }}>
    <button type="button" className="jv-side-row" data-active={selected === chat.id || undefined}
      data-unread={chat.unread > 0 || undefined} aria-current={selected === chat.id ? "page" : undefined} onClick={() => onSelect(chat)}>
      {chat.pinned ? <Pin className="jv-side-pin" aria-label="已置顶"/> : <span className="jv-hash" aria-hidden="true">#</span>}
      <span className="jv-side-text">
        <span className="jv-side-line"><span className="jv-side-label" title={chat.title}>{chat.title}</span>
          {chat.muted && <span className="jv-side-muted" aria-label="免打扰"><Icon name="bell-slash"/></span>}</span>
        <span className="jv-side-line"><Digest chat={chat} channel/><Badge chat={chat}/></span>
      </span>
    </button>
    <button type="button" className="jv-side-more" aria-label={`${chat.title} 的更多操作`} onClick={event => onMenu({ kind: "channel", chat }, below(event.currentTarget))}><Ellipsis aria-hidden="true"/></button>
  </div>;
  // The whole group name folds and unfolds the group, like Discord categories.
  const head = (key: string, label: string, closed: boolean, unread: boolean, section?: Section) => <div className="jv-side-section-head">
    <button type="button" className="jv-side-section-toggle" aria-expanded={!closed} onClick={() => toggle(key)}>
      <span className="jv-side-chevron"><Icon name={closed ? "chevron-right" : "chevron-down"}/></span>
      <span className="jv-side-section-name">{label}{closed && unread && <span className="jv-dot" aria-label="有未读"/>}</span></button>
    {section && <button type="button" className="jv-side-section-edit" aria-label={`编辑分组：${label}`} onClick={() => onEditSection(section)}><Icon name="pencil"/></button>}
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
          placeholder="搜索会话" aria-label="搜索会话" className="text-sm"/>
        <InputGroupAddon align="inline-start"><Search aria-hidden="true"/></InputGroupAddon>
      </InputGroup>
    </div>
    <ScrollArea className="min-h-0 flex-1" type="auto">
      <nav className="jv-side-nav px-3 pb-6" aria-label="频道与私信">
        {followed.length > 0 && <button type="button" className="jv-side-row jv-side-top" data-active={followedOpen || undefined} data-unread={threadUnread > 0 || undefined}
          aria-current={followedOpen ? "page" : undefined} onClick={onOpenFollowed}>
          <Icon name="chat-bubble"/><span className="jv-side-label">我关注的线程</span>
          {threadMentions > 0 ? <span className="jv-badge">{threadMentions}</span> : threadUnread > 0 && <span className="jv-count">{threadUnread}</span>}
        </button>}
        {sections.map(section => group(`s:${section.id}`, section.name, channels.filter(chat => chat.sectionId === section.id), section))}
        {channels.some(chat => !chat.sectionId || !sections.some(section => section.id === chat.sectionId)) &&
          group("channels", "频道", channels.filter(chat => !chat.sectionId || !sections.some(section => section.id === chat.sectionId)))}
        <div className="jv-side-section">
          {head("dms", "私信", isClosed("dms"), dms.some(({ chat }) => !!chat?.unread))}
          {!isClosed("dms") && <div className="space-y-1">{dms.map(({ bot, chat }) => {
            const badge = asking.has(bot.id) ? "asking" : working.has(bot.id) ? "working" : undefined, active = !!chat && selected === chat.id;
            return <div className="shadcn-chat-row relative" key={bot.id}
              onContextMenu={event => { event.preventDefault(); onMenu({ kind: "dm", bot, chat }, { x: event.clientX, y: event.clientY }); }}>
              <Button type="button" variant="ghost" data-active={active} aria-current={active ? "page" : undefined}
                className="h-15 w-full justify-start gap-2.5 rounded-md px-2 text-left hover:bg-accent/70 data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
                onClick={() => chat ? onSelect(chat) : onOpenBot(bot)}>
                <BotAvatar color={bot.color} mood={bot.mood} size={36} badge={badge}/>
                {badge && <span className="sr-only">{badge === "asking" ? "（等你回答）" : "（工作中）"}</span>}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate text-sm ${chat?.unread ? "font-semibold" : "font-medium"}`} title={bot.name}>{bot.name}</span>
                    {chat?.muted && <span className="jv-side-muted" aria-label="免打扰"><Icon name="bell-slash"/></span>}
                    {chat?.pinned && <Pin className="jv-dm-pin shrink-0" aria-label="已置顶"/>}
                    {chat && <time className="shadcn-chat-time shrink-0 text-[11px] font-normal text-muted-foreground" dateTime={new Date(chat.updatedAt).toISOString()}>
                      {new Date(chat.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                    </time>}
                  </span>
                  <span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">{chat ? <Digest chat={chat} channel={false}/> : ""}</span>{chat && <Badge chat={chat}/>}</span>
                </span>
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`${bot.name} 的更多操作`}
                className="shadcn-chat-more absolute top-4 right-2 opacity-0" onClick={event => onMenu({ kind: "dm", bot, chat }, below(event.currentTarget))}>
                <Ellipsis aria-hidden="true"/>
              </Button>
            </div>;
          })}</div>}
          {!isClosed("dms") && dms.length === 0 && <p className="jv-side-empty">{filter ? "无匹配结果" : "暂无私信"}</p>}
        </div>
      </nav>
    </ScrollArea>
  </>;
}
