import { useState } from "react";
import { api, type Bot, type BotStatus, type Chat, type Member } from "../api";
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

/** The 成员 page of channel info: people, then Bots with what each is doing. Adding opens the member picker;
 * removing asks first; clicking a Bot opens its Bot info. */
export function MemberList({ channel, members, bots, statuses, me, onAdd, onBot, onChanged, onError }: {
  channel: Chat; members: Member[]; bots: Bot[]; statuses: Record<string, BotStatus>; me: string;
  onAdd: () => void; onBot: (id: string) => void; onChanged: (chat: Chat) => void; onError: (error: unknown) => void;
}) {
  const [removing, setRemoving] = useState<Member | null>(null);
  const inside = members.filter(member => channel.memberIds.includes(member.id));
  const people = inside.filter(member => member.kind !== "bot").sort((a, b) => Number(b.id === me) - Number(a.id === me));
  const botMembers = inside.filter(member => member.kind === "bot");
  const row = (member: Member) => {
    const bot = member.kind === "bot" ? bots.find(item => item.id === member.id) : undefined, status = statuses[member.id];
    const state = member.kind === "bot" ? botState(bot, status) : undefined;
    const body = <>
      <MemberAvatar member={member} bots={bots} size={28} working={status?.status === "running" && status.activity !== "asking"}/>
      <span className="jv-member-name">{member.name}{member.id === me && <span className="jv-role">{t("common.you")}</span>}</span>
      {state && <span className="jv-member-state" data-tone={state.tone}>{state.label}</span>}
    </>;
    return <div key={member.id} className="jv-member-row">
      {bot ? <button type="button" className="jv-member-main" aria-label={t("members.view", { name: member.name })} onClick={() => onBot(member.id)}>{body}</button>
        : <div className="jv-member-main">{body}</div>}
      {member.id !== me && <IconButton icon="close" label={t("members.remove", { name: member.name })} className="jv-member-remove" onClick={() => setRemoving(member)}/>}
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
    {removing && <ConfirmDialog title={t("members.removeTitle", { name: removing.name, channel: channel.title })} body={t("members.removeBody")} confirm={t("members.removeConfirm")}
      onClose={() => setRemoving(null)} onConfirm={async () => {
        try { onChanged(await api.removeMember(channel.id, removing.id)); setRemoving(null); } catch (error) { onError(error); }
      }}/>}
  </>;
}
