import { useEffect, useRef } from "react";
import type { Bot, Chat } from "../api";
import { t } from "../i18n";
import { Icon } from "../ui";

export type MenuTarget = { kind: "dm"; bot: Bot; chat: Chat | undefined } | { kind: "channel"; chat: Chat };

/** The 「…」 menu of a sidebar row: same menu from the button and from a right-click.
 * DMs: 置顶 / 免打扰 / Bot 信息 / 删除 Bot; channels: 置顶 / 免打扰 / 频道信息 / 删除频道. */
export function EntryMenu({ target, x, y, onClose, onOpenBot, onSettings, onPin, onMute, onDeleteChat, onDeleteBot }: {
  target: MenuTarget; /** Viewport point to open at; kept inside the window. */ x: number; y: number;
  onClose: () => void; onOpenBot: (bot: Bot) => void; onSettings: (chat: Chat) => void;
  onPin: (chat: Chat, pinned: boolean) => void; onMute: (chat: Chat, muted: boolean) => void; onDeleteChat: (chat: Chat) => void; onDeleteBot: (bot: Bot) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => { if (!box.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key); };
  }, [onClose]);
  const chat = target.chat;
  const style = { left: Math.max(8, Math.min(x, window.innerWidth - 200)), top: Math.max(8, Math.min(y, window.innerHeight - 210)) };
  return <div ref={box} className="ui-popover jv-entry-menu" role="menu" aria-label={t("entry.menu")} style={style}>
    {chat && <button role="menuitem" className="ui-menu-item" onClick={() => { onPin(chat, !chat.pinned); onClose(); }}>
      <Icon name="pin"/><span className="ui-menu-copy">{t(chat.pinned ? "entry.unpin" : "entry.pin")}</span></button>}
    {chat && <button role="menuitem" className="ui-menu-item" onClick={() => { onMute(chat, !chat.muted); onClose(); }}>
      <Icon name={chat.muted ? "bell" : "bell-slash"}/><span className="ui-menu-copy">{t(chat.muted ? "entry.unmute" : "entry.mute")}</span></button>}
    {target.kind === "dm"
      ? <button role="menuitem" className="ui-menu-item" onClick={() => { onOpenBot(target.bot); onClose(); }}><Icon name="gear"/><span className="ui-menu-copy">{t("entry.botInfo")}</span></button>
      : <button role="menuitem" className="ui-menu-item" onClick={() => { onSettings(target.chat); onClose(); }}><Icon name="info"/><span className="ui-menu-copy">{t("entry.channelInfo")}</span></button>}
    <hr className="ui-menu-divider"/>
    {target.kind === "dm"
      ? <button role="menuitem" className="ui-menu-item jv-menu-danger" onClick={() => { onDeleteBot(target.bot); onClose(); }}>
        <Icon name="close"/><span className="ui-menu-copy">{t("entry.deleteBot")}</span></button>
      : <button role="menuitem" className="ui-menu-item jv-menu-danger" onClick={() => { onDeleteChat(target.chat); onClose(); }}>
        <Icon name="close"/><span className="ui-menu-copy">{t("entry.deleteChannel")}</span></button>}
  </div>;
}
