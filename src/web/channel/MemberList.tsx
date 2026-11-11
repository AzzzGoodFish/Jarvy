import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { type Bot, type BotStatus } from "../../contract/bots";
import { type Chat, type Member } from "../../contract/chat";
import { ConfirmDialog } from "../dm/DeleteDialog";
import { Icon, IconButton } from "../ui";
import { t } from "../i18n";
import { activityLabel } from "../members";
import { MemberAvatar } from "./ChannelView";

/** What a Bot is doing: its activity while running (as in the sidebar), else 空闲 or 未运行. */
function botState(bot: Bot | undefined, status: BotStatus | undefined): { label: string; tone?: "busy" | "error" } {
  if (!bot?.connectionId) return { label: t("activity.noModel") };
  if (status?.error) return { label: t("activity.error"), tone: "error" };
  if (status?.status === "running") return { label: activityLabel(status.activity), tone: "busy" };
  return { label: t(status?.status === "idle" ? "activity.idle" : "activity.stopped") };
}

/** A member's 「…」 menu, its right edge under the button's: making a Bot an admin or not (A90; the creator is one
 * anyway), and removing them. */
function MemberMenu({ x, y, admin, onAdmin, onRemove, onClose }: { x: number; y: number; admin: boolean | null; onAdmin: () => void; onRemove: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key); };
  }, [onClose]);
  const style = { right: Math.max(8, window.innerWidth - x), top: Math.max(8, Math.min(y, window.innerHeight - 100)) };
  return <div ref={box} className="ui-popover jv-entry-menu" role="menu" aria-label={t("members.menu")} style={style}>
    {admin !== null && <><button role="menuitem" className="ui-menu-item" onClick={() => { onAdmin(); onClose(); }}>
      <span className="ui-menu-copy">{t(admin ? "members.removeAdmin" : "members.makeAdmin")}</span></button><hr className="ui-menu-divider"/></>}
    <button role="menuitem" className="ui-menu-item jv-menu-danger" onClick={() => { onRemove(); onClose(); }}>
      <span className="ui-menu-copy">{t("members.removeFromChannel")}</span></button>
  </div>;
}

/** The 成员 page of channel info: people, then Bots with what each is doing, the channel's creator and admins marked
 * (A90). Adding opens the member picker; a member's 「…」 makes a Bot an admin or not and removes, asking first;
 * clicking a Bot opens its Bot info. */
export function MemberList({ channel, members, bots, statuses, me, onAdd, onBot, onChanged, onError }: {
  channel: Chat; members: Member[]; bots: Bot[]; statuses: Record<string, BotStatus>; me: string;
  onAdd: () => void; onBot: (id: string) => void; onChanged: (chat: Chat) => void; onError: (error: unknown) => void;
}) {
  const [removing, setRemoving] = useState<Member | null>(null), [menu, setMenu] = useState<{ member: Member; x: number; y: number } | null>(null);
  const setAdmin = async (member: Member, admin: boolean) => { try { onChanged(await api.setAdmin(channel.id, member.id, admin)); } catch (error) { onError(error); } };
  const inside = members.filter(member => channel.memberIds.includes(member.id));
  const people = inside.filter(member => member.kind !== "bot").sort((a, b) => Number(b.id === me) - Number(a.id === me));
  const botMembers = inside.filter(member => member.kind === "bot");
  const row = (member: Member) => {
    const bot = member.kind === "bot" ? bots.find(item => item.id === member.id) : undefined, status = statuses[member.id];
    const state = member.kind === "bot" ? botState(bot, status) : undefined;
    const body = <>
      <MemberAvatar member={member} bots={bots} size={28} working={status?.status === "running" && status.activity !== "asking"}/>
      <span className="jv-member-name">{member.name}{member.id === me && <span className="jv-role">{t("common.you")}</span>}
        {member.id === channel.createdBy ? <span className="jv-role">{t("members.creator")}</span>
          : channel.adminIds.includes(member.id) && <span className="jv-role">{t("members.admin")}</span>}</span>
      {state && <span className="jv-member-state" data-tone={state.tone}>{state.label}</span>}
    </>;
    return <div key={member.id} className="jv-member-row">
      {bot ? <button type="button" className="jv-member-main" aria-label={t("members.view", { name: member.name })} onClick={() => onBot(member.id)}>{body}</button>
        : <div className="jv-member-main">{body}</div>}
      {member.id !== me && <IconButton icon="more" label={t("members.more", { name: member.name })} className="jv-member-remove"
        onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ member, x: box.right, y: box.bottom + 4 }); }}/>}
    </div>;
  };
  return <>
    <div className="jv-member-bar"><span>{t("members.count", { count: inside.length })}</span>
      <button type="button" className="ui-button ui-primary jv-member-pane-add" onClick={onAdd}><Icon name="person-add"/>{t("common.add")}</button></div>
    <div className="ui-pane-body jv-pane-body">
      {([["people", t("members.people"), people], ["bots", "Bot", botMembers]] as const).map(([group, label, list]) => list.length > 0 && <section key={group} className="jv-member-group" aria-label={label}>
        <h3>{label} · {list.length}</h3>{list.map(row)}
      </section>)}
    </div>
    {menu && <MemberMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} onRemove={() => setRemoving(menu.member)}
      admin={menu.member.kind === "bot" && menu.member.id !== channel.createdBy ? channel.adminIds.includes(menu.member.id) : null}
      onAdmin={() => void setAdmin(menu.member, !channel.adminIds.includes(menu.member.id))}/>}
    {removing && <ConfirmDialog title={t("members.removeTitle", { name: removing.name, channel: channel.title })} body={t("members.removeBody")} confirm={t("members.removeConfirm")}
      onClose={() => setRemoving(null)} onConfirm={async () => {
        try { onChanged(await api.removeMember(channel.id, removing.id)); setRemoving(null); } catch (error) { onError(error); }
      }}/>}
  </>;
}
