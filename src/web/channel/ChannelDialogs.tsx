import { useId, useState, type FormEvent } from "react";
import { SectionSelect } from "./SectionSelect";
import { api } from "../api";
import { type Bot } from "../../contract/bots";
import { type Chat, type Member, type Section } from "../../contract/chat";
import { Icon, IconButton, Modal } from "../ui";
import { MemberAvatar } from "./ChannelView";
import { t } from "../i18n";
import { errorText } from "../errors";
import { useAction } from "../action";

/** Add people the usual chat-app way: search, pick one or more, confirm. */
function MemberPicker({ candidates, bots, busy, onCancel, onConfirm }: {
  candidates: Member[]; bots: Bot[]; busy: boolean; onCancel: () => void; onConfirm: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState(""), [picked, setPicked] = useState<string[]>([]);
  const shown = candidates.filter(member => member.name.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) => setPicked(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  return <div className="jv-picker">
    <div className="ui-field"><input type="search" value={query} autoFocus placeholder={t("common.searchMembers")} aria-label={t("common.searchMembers")} onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (shown.length === 1) toggle(shown[0]!.id); } }}/></div>
    <div className="jv-picker-list" role="listbox" aria-multiselectable="true" aria-label={t("dialogs.candidates")}>
      {shown.map(member => <button key={member.id} type="button" role="option" aria-selected={picked.includes(member.id)} className="jv-member-option" onClick={() => toggle(member.id)}>
        <MemberAvatar member={member} bots={bots} size={24}/><span className="jv-member-name">{member.name}</span>
        <span className="jv-muted">{member.kind === "bot" ? "Bot" : t("common.member")}</span><span className="jv-check">{picked.includes(member.id) && <Icon name="check"/>}</span>
      </button>)}
      {shown.length === 0 && <p className="jv-picker-empty">{t(candidates.length ? "common.noMatch" : "dialogs.allInside")}</p>}
    </div>
    <div className="ui-dialog-actions">
      <span className="jv-spacer"/>
      <button type="button" className="ui-button" onClick={onCancel}>{t("common.cancel")}</button>
      <button type="button" className="ui-button ui-primary" disabled={busy || picked.length === 0} onClick={() => onConfirm(picked)}>{picked.length ? t("dialogs.addCount", { count: picked.length }) : t("common.add")}</button>
    </div>
  </div>;
}

/** Add members to a channel (from channel info); each pick takes effect at once and confirming closes the dialog. */
export function AddMembersDialog({ chat, members, bots, onClose, onChanged }: {
  chat: Chat; members: Member[]; bots: Bot[]; onClose: () => void; onChanged: (chat: Chat) => void;
}) {
  const { busy, error, run } = useAction();
  async function add(picked: string[]) {
    await run("add", async () => {
      let saved = chat;
      for (const id of picked) saved = await api.addMember(chat.id, id);
      onChanged(saved); onClose();
    }, "dialogs.addFailed");
  }
  return <Modal title={t("info.addMembers")} onClose={onClose} className="jv-channel-dialog">
    <MemberPicker candidates={members.filter(member => !chat.memberIds.includes(member.id))} bots={bots} busy={busy} onCancel={onClose} onConfirm={picked => void add(picked)}/>
    {error && <p className="jv-form-error" role="alert">{error}</p>}
  </Modal>;
}

/** Create a channel: name, topic, group (optional, A37) and first members. Existing channels are edited in channel info. */
export function NewChannelDialog({ sections, members, bots, me, onClose, onSaved }: {
  sections: Section[]; members: Member[]; bots: Bot[]; me: string; onClose: () => void; onSaved: (chat: Chat) => void;
}) {
  const ids = useId();
  const [name, setName] = useState(""), [topic, setTopic] = useState(""), [sectionId, setSectionId] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([me]), [picking, setPicking] = useState(false);
  const { busy, error, run } = useAction();
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    await run("save", async () => onSaved(await api.createChannel({ name: name.trim(), topic: topic.trim(), sectionId, memberIds: memberIds.filter(id => id !== me) })), "common.saveFailed");
  }
  const current = members.filter(member => memberIds.includes(member.id));
  if (picking) return <Modal title={t("info.addMembers")} onClose={onClose} className="jv-channel-dialog">
    <MemberPicker candidates={members.filter(member => !memberIds.includes(member.id))} bots={bots} busy={false}
      onCancel={() => setPicking(false)} onConfirm={picked => { setMemberIds(previous => [...previous, ...picked]); setPicking(false); }}/>
  </Modal>;
  return <Modal title={t("sidebar.newChannel")} onClose={onClose} className="jv-channel-dialog">
    <form onSubmit={event => void save(event)}>
      <div className="ui-field"><label htmlFor={`${ids}-name`}>{t("info.name")}</label>
        <input id={`${ids}-name`} value={name} maxLength={80} autoFocus placeholder={t("info.newChannel")} onChange={event => setName(event.target.value)}/></div>
      <div className="ui-field"><label htmlFor={`${ids}-topic`}>{t("info.topic")}</label>
        <input id={`${ids}-topic`} value={topic} maxLength={200} placeholder={t("dialogs.optional")} onChange={event => setTopic(event.target.value)}/></div>
      <div className="ui-field"><label htmlFor={`${ids}-section`}>{t("info.section")}</label>
        <SectionSelect id={`${ids}-section`} value={sectionId} sections={sections} onChange={setSectionId}/></div>
      <div className="jv-members">
        <div className="jv-members-head"><span>{t("channel.members")} · {current.length}</span>
          <button type="button" className="ui-button" onClick={() => setPicking(true)}><Icon name="person-add"/>{t("info.addMembers")}</button></div>
        {current.map(member => <div key={member.id} className="jv-member-option">
          <MemberAvatar member={member} bots={bots} size={24}/><span className="jv-member-name">{member.name}</span>
          <span className="jv-muted">{member.id === me ? t("common.you") : member.kind === "bot" ? "Bot" : t("common.member")}</span>
          {member.id !== me && <IconButton icon="close" label={t("members.remove", { name: member.name })} className="jv-member-remove"
            onClick={() => setMemberIds(previous => previous.filter(id => id !== member.id))}/>}
        </div>)}
      </div>
      {error && <p className="jv-form-error" role="alert">{error}</p>}
      <div className="ui-dialog-actions">
        <span className="jv-spacer"/>
        <button type="button" className="ui-button" onClick={onClose}>{t("common.cancel")}</button>
        <button type="submit" className="ui-button ui-primary" disabled={busy || !name.trim()}>{t("common.create")}</button>
      </div>
    </form>
  </Modal>;
}

/** Create, rename or delete a channel group (Section, shown like a Discord category). Deleting keeps
 * its channels, which move to 「频道」. */
export function SectionDialog({ section, onClose, onSaved, onDeleted }: {
  section?: Section; onClose: () => void; onSaved: (section: Section) => void; onDeleted?: (id: string) => void;
}) {
  const ids = useId();
  const [name, setName] = useState(section?.name ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    try { onSaved(section ? await api.updateSection(section.id, { name: name.trim() }) : await api.createSection({ name: name.trim() })); }
    catch (reason) { setError(errorText(reason, "common.saveFailed")); setBusy(false); }
  }
  async function remove() {
    if (!section || !confirm(t("dialogs.deleteSection", { name: section.name }))) return;
    setBusy(true);
    try { await api.deleteSection(section.id); onDeleted?.(section.id); }
    catch (reason) { setError(errorText(reason, "dialogs.deleteFailed")); setBusy(false); }
  }
  return <Modal title={t(section ? "dialogs.editSection" : "sidebar.newSection")} onClose={onClose}>
    <form onSubmit={event => void save(event)}>
      <div className="ui-field"><label htmlFor={`${ids}-name`}>{t("dialogs.sectionName")}</label>
        <input id={`${ids}-name`} value={name} maxLength={80} autoFocus placeholder={t("dialogs.newSection")} onChange={event => setName(event.target.value)}/></div>
      {error && <p className="jv-form-error" role="alert">{error}</p>}
      <div className="ui-dialog-actions">
        {section && <button type="button" className="ui-button jv-danger" disabled={busy} onClick={() => void remove()}>{t("common.delete")}</button>}
        <span className="jv-spacer"/>
        <button type="button" className="ui-button" onClick={onClose}>{t("common.cancel")}</button>
        <button type="submit" className="ui-button ui-primary" disabled={busy || !name.trim()}>{t(section ? "common.save" : "common.create")}</button>
      </div>
    </form>
  </Modal>;
}
