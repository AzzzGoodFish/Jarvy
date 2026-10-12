import { useEffect, useId, useState } from "react";
import { SectionSelect } from "./SectionSelect";
import { api, type Bot, type BotStatus, type Chat, type Member, type Section } from "../api";
import { Icon, IconButton } from "../ui";
import { MemberList } from "./MemberList";

export type InfoPage = "main" | "members";

/** One editable line of channel info: shows the value, the pencil turns it into an input (Enter saves, Esc cancels). */
function InfoField({ label, value, empty, maxLength, required = false, onSave }: {
  label: string; value: string; empty: string; maxLength: number; required?: boolean; onSave: (value: string) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => setDraft(null), [value]);
  const save = async () => {
    if (draft === null || busy || (required && !draft.trim())) return;
    if (draft.trim() === value) { setDraft(null); return; }
    setBusy(true); try { await onSave(draft.trim()); setDraft(null); } catch { /* the caller shows the error */ } finally { setBusy(false); }
  };
  return <div className="jv-info-field">
    <div className="jv-info-label"><label htmlFor={id}>{label}</label>
      {draft === null && <IconButton icon="pencil" label={`编辑${label}`} className="jv-info-edit" onClick={() => setDraft(value)}/>}</div>
    {draft === null ? <p className="jv-info-value" data-empty={!value || undefined}>{value || empty}</p>
      : <div className="jv-inline-edit">
        <input id={id} value={draft} maxLength={maxLength} autoFocus placeholder={empty} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(); } if (event.key === "Escape") { event.stopPropagation(); setDraft(null); } }}/>
        <button type="button" className="ui-button" onClick={() => setDraft(null)}>取消</button>
        <button type="button" className="ui-button ui-primary" disabled={busy || (required && !draft.trim())} onClick={() => void save()}>保存</button>
      </div>}
  </div>;
}

/** Channel info in the side pane, the channel's main menu: pin, mute and add members; name, topic and group edited in place;
 * the member list as a sub-page; deleting the channel. */
export function ChannelInfo({ channel, page, sections, members, bots, statuses, me, onPage, onPin, onMute, onAdd, onBot, onDelete, onChanged, onClose, onError }: {
  channel: Chat; page: InfoPage; sections: Section[]; members: Member[]; bots: Bot[]; statuses: Record<string, BotStatus>; me: string;
  onPage: (page: InfoPage) => void; onPin: () => void; onMute: () => void; onAdd: () => void; onBot: (id: string) => void; onDelete: () => void;
  onChanged: (chat: Chat) => void; onClose: () => void; onError: (error: unknown) => void;
}) {
  const sectionId = useId();
  const update = async (change: { name?: string; topic?: string; sectionId?: string | null }) => {
    try { onChanged(await api.updateChannel(channel.id, change)); } catch (error) { onError(error); throw error; }
  };
  const count = members.filter(member => channel.memberIds.includes(member.id)).length;
  return <aside className="ui-pane jv-pane" aria-label={page === "members" ? "成员列表" : "频道信息"}>
    <header className="ui-pane-header jv-pane-header">
      {page === "members" && <IconButton icon="chevron-left" label="返回频道信息" className="jv-pane-back" onClick={() => onPage("main")}/>}
      <strong>{page === "members" ? "成员" : "频道信息"}</strong><span className="jv-muted jv-pane-sub">#{channel.title}</span><span className="jv-spacer"/>
      <IconButton icon="close" label="关闭" onClick={onClose}/></header>
    {page === "members" ? <MemberList channel={channel} members={members} bots={bots} statuses={statuses} me={me} onAdd={onAdd} onBot={onBot} onChanged={onChanged} onError={onError}/>
      : <div className="ui-pane-body jv-pane-body jv-info">
        <div className="jv-info-actions">
          <button type="button" aria-pressed={channel.pinned} onClick={onPin}><Icon name="pin"/>置顶</button>
          <button type="button" aria-pressed={channel.muted} onClick={onMute}><Icon name={channel.muted ? "bell-slash" : "bell"}/>免打扰</button>
          <button type="button" onClick={onAdd}><Icon name="person-add"/>添加成员</button>
        </div>
        <InfoField label="名称" value={channel.title} empty="新频道" maxLength={80} required onSave={name => update({ name })}/>
        <InfoField label="主题" value={channel.topic} empty="暂无主题" maxLength={200} onSave={topic => update({ topic })}/>
        <div className="jv-info-field"><div className="jv-info-label"><label htmlFor={sectionId}>分组</label></div>
          <SectionSelect id={sectionId} value={channel.sectionId} sections={sections} onChange={next => void update({ sectionId: next }).catch(() => {})}/></div>
        <nav className="jv-info-menu" aria-label="频道">
          <button type="button" className="ui-menu-item" onClick={() => onPage("members")}><Icon name="people"/><span className="ui-menu-copy">成员</span>
            <span className="jv-muted">{count}</span><Icon name="chevron-right"/></button>
          <button type="button" className="ui-menu-item jv-menu-danger" onClick={onDelete}><Icon name="trash"/><span className="ui-menu-copy">删除频道</span></button>
        </nav>
      </div>}
  </aside>;
}
