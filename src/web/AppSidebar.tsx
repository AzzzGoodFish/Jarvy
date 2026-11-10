import type { Bot } from "../contract/bots";
import type { Chat, Member, Section } from "../contract/chat";
import type { FollowedSummary } from "../contract/threads";
import { Sidebar } from "./sidebar/Sidebar";
import { Icon, IconButton } from "./ui";
import { t } from "./i18n";
import { type MenuTarget } from "./sidebar/EntryMenu";
import { useEffect, useRef } from "react";

/** The chat list's column: the list with its search box and the create menu. The account entry is the rail's (A87). */
export function AppSidebar({ chats, sections, bots, members, followed, followedOpen, working, asking, selected, filter, creating, createMenu,
  onFilterChange, onOpenFollowed, onOpenChat, onOpenBot, onOpenMenu, onEditSection, onCreate, onFind, onOpenFound, onError, onToggleCreate }: {
  chats: Chat[]; sections: Section[]; bots: Bot[]; members: Member[]; followed: FollowedSummary | null; followedOpen: boolean;
  working: Set<string>; asking: Set<string>;
  /** The open chat, or null while the followed-threads page is shown. */
  selected: string | null; filter: string; creating: boolean; createMenu: boolean;
  onFilterChange: (value: string) => void; onOpenFollowed: () => void; onOpenChat: (chat: Chat) => void; onOpenBot: (bot: Bot) => void;
  onOpenMenu: (target: MenuTarget, at: { x: number; y: number }) => void;
  onEditSection: (section: Section) => void;
  /** The create menu: a new channel, a new channel group, or a new Bot. */
  onCreate: (what: "channel" | "section" | "bot") => void;
  /** Opening a search result, and the followed-threads page's own navigation. */
  onFind: (chat: Chat, id: string) => void; onOpenFound: (chat: Chat) => void; onError: (error: unknown) => void;
  onToggleCreate: (open: boolean) => void;
}) {
  const createRef = useRef<HTMLDivElement>(null);
  // A press outside the open create menu closes it.
  useEffect(() => {
    if (!createMenu) return;
    const close = (event: PointerEvent) => { if (!createRef.current?.contains(event.target as Node)) onToggleCreate(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [createMenu]);
  return <aside className="ui-sidebar" aria-label={t("sidebar.label")}>
    <header className="ui-sidebar-header"><div className="jarvy-sidebar-create" ref={createRef}>
      <IconButton icon="add" label={t("sidebar.create")} aria-expanded={createMenu} aria-haspopup="menu" disabled={creating} onClick={() => onToggleCreate(!createMenu)}/>
      {createMenu && <div className="ui-popover jarvy-create-menu" role="menu" aria-label={t("sidebar.createMenu")}>
        <button role="menuitem" className="ui-menu-item" onClick={() => onCreate("channel")}><Icon name="list-bullets"/><span className="ui-menu-copy">{t("sidebar.newChannel")}</span></button>
        <button role="menuitem" className="ui-menu-item" onClick={() => onCreate("section")}><Icon name="folder"/><span className="ui-menu-copy">{t("sidebar.newSection")}</span></button>
        <button role="menuitem" className="ui-menu-item" onClick={() => onCreate("bot")}><Icon name="person-add"/><span className="ui-menu-copy">{t("sidebar.newBot")}</span></button>
      </div>}
    </div></header>
    <Sidebar chats={chats} sections={sections} bots={bots} members={members} onOpenMessage={onFind} onOpenFound={onOpenFound} onError={onError}
      working={working} asking={asking} selected={selected} filter={filter} onFilterChange={onFilterChange}
      followed={followed} followedOpen={followedOpen} onOpenFollowed={onOpenFollowed}
      onSelect={onOpenChat} onOpenBot={onOpenBot} onMenu={onOpenMenu} onEditSection={onEditSection}/>
  </aside>;
}
