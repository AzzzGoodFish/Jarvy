import { useState } from "react";
import { api, type Bot, type BotStatus, type Chat, type Member } from "../api";
import { ConfirmDialog } from "../dm/DeleteDialog";
import { Icon, IconButton } from "../ui";
import { MemberAvatar } from "./ChannelView";

const ACTIVITY: Record<string, string> = { reasoning: "思考中", texting: "处理中", tool_calling: "执行工具", asking: "等你回答" };

/** What a Bot is doing: its activity while running (as in the sidebar), else 空闲 or 未运行. */
function botState(bot: Bot | undefined, status: BotStatus | undefined): { label: string; tone?: "busy" | "error" } {
  if (!bot?.connectionId) return { label: "未设置模型" };
  if (status?.error) return { label: "运行出错", tone: "error" };
  if (status?.status === "running") return { label: ACTIVITY[status.activity ?? ""] ?? "运行中", tone: "busy" };
  return { label: status?.status === "idle" ? "空闲" : "未运行" };
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
      <span className="jv-member-name">{member.name}{member.id === me && <span className="jv-role">你</span>}</span>
      {state && <span className="jv-member-state" data-tone={state.tone}>{state.label}</span>}
    </>;
    return <div key={member.id} className="jv-member-row">
      {bot ? <button type="button" className="jv-member-main" aria-label={`查看 ${member.name}`} onClick={() => onBot(member.id)}>{body}</button>
        : <div className="jv-member-main">{body}</div>}
      {member.id !== me && <IconButton icon="close" label={`移出 ${member.name}`} className="jv-member-remove" onClick={() => setRemoving(member)}/>}
    </div>;
  };
  return <>
    <div className="jv-member-bar"><span>{inside.length} 位成员</span>
      <button type="button" className="ui-button ui-primary jv-member-pane-add" onClick={onAdd}><Icon name="person-add"/>添加</button></div>
    <div className="ui-pane-body jv-pane-body">
      {([["人", people], ["Bot", botMembers]] as const).map(([label, list]) => list.length > 0 && <section key={label} className="jv-member-group" aria-label={label}>
        <h3>{label} · {list.length}</h3>{list.map(row)}
      </section>)}
    </div>
    {removing && <ConfirmDialog title={`把 ${removing.name} 移出 #${channel.title}`} body="移出后不再收到这个频道的消息。" confirm="移出"
      onClose={() => setRemoving(null)} onConfirm={async () => {
        try { onChanged(await api.removeMember(channel.id, removing.id)); setRemoving(null); } catch (error) { onError(error); }
      }}/>}
  </>;
}
