import type { Bot, Chat, Member, Section, ThreadEntry } from "./api";
import { Sidebar } from "./sidebar/Sidebar";
import { Icon, IconButton } from "./ui";
import { type MenuTarget } from "./sidebar/EntryMenu";
import { useEffect, useRef } from "react";

/** The left column: the chat list with its search box, the create menu, the account entry; and the account menu. */
export function AppSidebar({ username, chats, sections, bots, members, followed, followedOpen, working, asking, selected, filter, creating, createMenu, accountMenu,
  onFilterChange, onOpenFollowed, onOpenChat, onOpenBot, onOpenMenu, onEditSection, onCreate, onFind, onOpenFound, onError, onToggleCreate, onToggleAccount,
  onSettings, onToggleTheme, onLogOut }: {
  username: string; chats: Chat[]; sections: Section[]; bots: Bot[]; members: Member[]; followed: ThreadEntry[]; followedOpen: boolean;
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
  return <><aside className="ui-sidebar" aria-label="会话列表">
    <header className="ui-sidebar-header"><div className="jarvy-sidebar-create" ref={createRef}>
      <IconButton icon="add" label="打开新建菜单" aria-expanded={createMenu} aria-haspopup="menu" disabled={creating} onClick={() => onToggleCreate(!createMenu)}/>
      {createMenu && <div className="ui-popover jarvy-create-menu" role="menu" aria-label="新建菜单">
        <button role="menuitem" className="ui-menu-item" onClick={() => onCreate("channel")}><Icon name="list-bullets"/><span className="ui-menu-copy">新建频道</span></button>
        <button role="menuitem" className="ui-menu-item" onClick={() => onCreate("section")}><Icon name="folder"/><span className="ui-menu-copy">新建频道分组</span></button>
        <button role="menuitem" className="ui-menu-item" onClick={() => onCreate("bot")}><Icon name="person-add"/><span className="ui-menu-copy">新建 Bot</span></button>
      </div>}
    </div></header>
    <Sidebar chats={chats} sections={sections} bots={bots} members={members} onOpenMessage={onFind} onOpenFound={onOpenFound} onError={onError}
      working={working} asking={asking} selected={selected} filter={filter} onFilterChange={onFilterChange}
      followed={followed} followedOpen={followedOpen} onOpenFollowed={onOpenFollowed}
      onSelect={onOpenChat} onOpenBot={onOpenBot} onMenu={onOpenMenu} onEditSection={onEditSection}/>
    <footer className="ui-sidebar-footer"><button type="button" className="ui-footer-entry" aria-label={`用户菜单，${username}`} aria-expanded={accountMenu}
      onClick={() => onToggleAccount(!accountMenu)}>
      <span className="ui-user-avatar">{username.slice(0, 2).toUpperCase()}</span><span>{username}</span><Icon name="chevron-down"/>
    </button></footer>
  </aside>
    {/* Outside the sidebar, whose stacking context (and transform on phones) would otherwise hold it. */}
    {accountMenu && <div ref={accountRef} className="ui-popover jarvy-account-menu" role="menu" aria-label="账户菜单">
      <div className="ui-menu-note ui-small">{username}</div>
      <button role="menuitem" className="ui-menu-item" onClick={onSettings}><Icon name="gear"/><span className="ui-menu-copy">设置</span></button>
      <button role="menuitem" className="ui-menu-item" onClick={onToggleTheme}><Icon name="moon"/><span className="ui-menu-copy">切换主题</span></button>
      <hr className="ui-menu-divider"/>
      <button role="menuitem" className="ui-menu-item" onClick={onLogOut}><Icon name="arrow-bracket-to-left"/><span className="ui-menu-copy">退出登录</span></button>
    </div>}
  </>;
}
