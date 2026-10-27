import { useEffect, useId, useState } from "react";
import { SectionSelect } from "./SectionSelect";
import { api } from "../api";
import { type Bot, type BotStatus } from "../../contract/bots";
import { type Chat, type Member, type Section } from "../../contract/chat";
import { Icon, IconButton } from "../ui";
import { MemberList } from "./MemberList";
import { t } from "../i18n";

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
      {draft === null && <IconButton icon="pencil" label={t("info.edit", { name: label })} className="jv-info-edit" onClick={() => setDraft(value)}/>}</div>
    {draft === null ? <p className="jv-info-value" data-empty={!value || undefined}>{value || empty}</p>
      : <div className="jv-inline-edit">
        <input id={id} value={draft} maxLength={maxLength} autoFocus placeholder={empty} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(); } if (event.key === "Escape") { event.stopPropagation(); setDraft(null); } }}/>
        <button type="button" className="ui-button" onClick={() => setDraft(null)}>{t("common.cancel")}</button>
        <button type="button" className="ui-button ui-primary" disabled={busy || (required && !draft.trim())} onClick={() => void save()}>{t("common.save")}</button>
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
  return <aside className="ui-pane jv-pane" aria-label={t(page === "members" ? "info.memberList" : "entry.channelInfo")}>
    <header className="ui-pane-header jv-pane-header">
      {page === "members" && <IconButton icon="chevron-left" label={t("info.back")} className="jv-pane-back" onClick={() => onPage("main")}/>}
      <strong>{t(page === "members" ? "channel.members" : "entry.channelInfo")}</strong><span className="jv-muted jv-pane-sub">#{channel.title}</span><span className="jv-spacer"/>
      <IconButton icon="close" label={t("common.close")} onClick={onClose}/></header>
    {page === "members" ? <MemberList channel={channel} members={members} bots={bots} statuses={statuses} me={me} onAdd={onAdd} onBot={onBot} onChanged={onChanged} onError={onError}/>
      : <div className="ui-pane-body jv-pane-body jv-info">
        <div className="jv-info-actions">
          <button type="button" aria-pressed={channel.pinned} onClick={onPin}><Icon name="pin"/>{t("entry.pin")}</button>
          <button type="button" aria-pressed={channel.muted} onClick={onMute}><Icon name={channel.muted ? "bell-slash" : "bell"}/>{t("entry.mute")}</button>
          <button type="button" onClick={onAdd}><Icon name="person-add"/>{t("info.addMembers")}</button>
        </div>
        <InfoField label={t("info.name")} value={channel.title} empty={t("info.newChannel")} maxLength={80} required onSave={name => update({ name })}/>
        <InfoField label={t("info.topic")} value={channel.topic} empty={t("info.noTopic")} maxLength={200} onSave={topic => update({ topic })}/>
        <div className="jv-info-field"><div className="jv-info-label"><label htmlFor={sectionId}>{t("info.section")}</label></div>
          <SectionSelect id={sectionId} value={channel.sectionId} sections={sections} onChange={next => void update({ sectionId: next }).catch(() => {})}/></div>
        <nav className="jv-info-menu" aria-label={t("info.menu")}>
          <button type="button" className="ui-menu-item" onClick={() => onPage("members")}><Icon name="people"/><span className="ui-menu-copy">{t("channel.members")}</span>
            <span className="jv-muted">{count}</span><Icon name="chevron-right"/></button>
          <button type="button" className="ui-menu-item jv-menu-danger" onClick={onDelete}><Icon name="trash"/><span className="ui-menu-copy">{t("entry.deleteChannel")}</span></button>
        </nav>
      </div>}
  </aside>;
}
