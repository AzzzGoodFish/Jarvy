import type { Bot } from "../contract/bots";
import type { Chat, Member, Section } from "../contract/chat";
import type { FollowedSummary } from "../contract/threads";
import { Sidebar } from "./sidebar/Sidebar";
import { Icon, IconButton } from "./ui";
import { t } from "./i18n";
import { type MenuTarget } from "./sidebar/EntryMenu";
import { useEffect, useRef } from "react";

/** The left column: the chat list with its search box, the create menu, the account entry; and the account menu. */
export function AppSidebar({ username, chats, sections, bots, members, followed, followedOpen, working, asking, selected, filter, creating, createMenu, accountMenu,
  onFilterChange, onOpenFollowed, onOpenChat, onOpenBot, onOpenMenu, onEditSection, onCreate, onFind, onOpenFound, onError, onToggleCreate, onToggleAccount,
  onSettings, onToggleTheme, onLogOut }: {
  username: string; chats: Chat[]; sections: Section[]; bots: Bot[]; members: Member[]; followed: FollowedSummary | null; followedOpen: boolean;
  working: Set<string>; asking: Set<string>;
  /** The open chat, or null while the followed-threads page is shown. */
  selected: string | null; filter: string; creating: boolean; createMenu: boolean; accountMenu: boolean;
  onFilterChange: (value: string) => void; onOpenFollowed: () => void; onOpenChat: (chat: Chat) => void; onOpenBot: (bot: Bot) => void;
  onOpenMenu: (target: MenuTarget, at: { x: number; y: number }) => void;
  onEditSection: (section: Section) => void;
  /** The create menu: a new channel, a new channel group, or a new Bot. */
  onCreate: (what: "channel" | "section" | "bot") => void;
  /** Opening a search result, and the followed-threads page's own navigation. */
  onFind: (chat: Chat, id: string) => void; onOpenFound: (chat: Chat) => void; onError: (error: unknown) => void;
  onToggleCreate: (open: boolean) => void; onToggleAccount: (open: boolean) => void;
  onSettings: () => void; onToggleTheme: () => void; onLogOut: () => void;
}) {
  const createRef = useRef<HTMLDivElement>(null), accountRef = useRef<HTMLDivElement>(null);
  // A press outside an open menu closes it; at most one of the two is open.
  useEffect(() => {
    if (!accountMenu && !createMenu) return;
    const close = (event: PointerEvent) => {
      if (accountMenu && !accountRef.current?.contains(event.target as Node)) onToggleAccount(false);
      if (createMenu && !createRef.current?.contains(event.target as Node)) onToggleCreate(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [accountMenu, createMenu]);
  return <><aside className="ui-sidebar" aria-label={t("sidebar.label")}>
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
    <footer className="ui-sidebar-footer"><button type="button" className="ui-footer-entry" aria-label={t("account.menuFor", { name: username })} aria-expanded={accountMenu}
      onClick={() => onToggleAccount(!accountMenu)}>
      <span className="ui-user-avatar">{username.slice(0, 2).toUpperCase()}</span><span>{username}</span><Icon name="chevron-down"/>
    </button></footer>
  </aside>
    {/* Outside the sidebar, whose stacking context (and transform on phones) would otherwise hold it. */}
    {accountMenu && <div ref={accountRef} className="ui-popover jarvy-account-menu" role="menu" aria-label={t("account.menu")}>
      <div className="ui-menu-note ui-small">{username}</div>
      <button role="menuitem" className="ui-menu-item" onClick={onSettings}><Icon name="gear"/><span className="ui-menu-copy">{t("settings.title")}</span></button>
      <button role="menuitem" className="ui-menu-item" onClick={onToggleTheme}><Icon name="moon"/><span className="ui-menu-copy">{t("account.toggleTheme")}</span></button>
      <hr className="ui-menu-divider"/>
      <button role="menuitem" className="ui-menu-item" onClick={onLogOut}><Icon name="arrow-bracket-to-left"/><span className="ui-menu-copy">{t("account.signOut")}</span></button>
    </div>}
  </>;
}
