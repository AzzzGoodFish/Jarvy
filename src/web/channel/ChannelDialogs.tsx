import { useId, useState, type FormEvent } from "react";
import { api, type Bot, type Chat, type Member, type Section } from "../api";
import { Icon, IconButton, Modal } from "../ui";
import { MemberAvatar } from "./ChannelView";

/** Add people the usual chat-app way: search, pick one or more, confirm. */
function MemberPicker({ candidates, bots, busy, onCancel, onConfirm }: {
  candidates: Member[]; bots: Bot[]; busy: boolean; onCancel: () => void; onConfirm: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState(""), [picked, setPicked] = useState<string[]>([]);
  const shown = candidates.filter(member => member.name.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) => setPicked(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  return <div className="jv-picker">
    <div className="ui-field"><input type="search" value={query} autoFocus placeholder="搜索成员" aria-label="搜索成员" onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (shown.length === 1) toggle(shown[0]!.id); } }}/></div>
    <div className="jv-picker-list" role="listbox" aria-multiselectable="true" aria-label="可添加的成员">
      {shown.map(member => <button key={member.id} type="button" role="option" aria-selected={picked.includes(member.id)} className="jv-member-option" onClick={() => toggle(member.id)}>
        <MemberAvatar member={member} bots={bots} size={24}/><span className="jv-member-name">{member.name}</span>
        <span className="jv-muted">{member.kind === "bot" ? "Bot" : "成员"}</span><span className="jv-check">{picked.includes(member.id) && <Icon name="check"/>}</span>
      </button>)}
      {shown.length === 0 && <p className="jv-picker-empty">{candidates.length ? "无匹配成员" : "所有成员都已在频道中"}</p>}
    </div>
    <div className="ui-dialog-actions">
      <span className="jv-spacer"/>
      <button type="button" className="ui-button" onClick={onCancel}>取消</button>
      <button type="button" className="ui-button ui-primary" disabled={busy || picked.length === 0} onClick={() => onConfirm(picked)}>添加{picked.length ? `（${picked.length}）` : ""}</button>
    </div>
  </div>;
}

/** Add members to a channel (from channel info); each pick takes effect at once and confirming closes the dialog. */
export function AddMembersDialog({ chat, members, bots, onClose, onChanged }: {
  chat: Chat; members: Member[]; bots: Bot[]; onClose: () => void; onChanged: (chat: Chat) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function add(picked: string[]) {
    setBusy(true); setError("");
    try {
      let saved = chat;
      for (const id of picked) saved = await api.addMember(chat.id, id);
      onChanged(saved); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "添加失败"); }
    finally { setBusy(false); }
  }
  return <Modal title="添加成员" onClose={onClose} className="jv-channel-dialog">
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
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    try { onSaved(await api.createChannel({ name: name.trim(), topic: topic.trim(), sectionId, memberIds: memberIds.filter(id => id !== me) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  }
  const current = members.filter(member => memberIds.includes(member.id));
  if (picking) return <Modal title="添加成员" onClose={onClose} className="jv-channel-dialog">
    <MemberPicker candidates={members.filter(member => !memberIds.includes(member.id))} bots={bots} busy={false}
      onCancel={() => setPicking(false)} onConfirm={picked => { setMemberIds(previous => [...previous, ...picked]); setPicking(false); }}/>
  </Modal>;
  return <Modal title="新建频道" onClose={onClose} className="jv-channel-dialog">
    <form onSubmit={event => void save(event)}>
      <div className="ui-field"><label htmlFor={`${ids}-name`}>名称</label>
        <input id={`${ids}-name`} value={name} maxLength={80} autoFocus placeholder="新频道" onChange={event => setName(event.target.value)}/></div>
      <div className="ui-field"><label htmlFor={`${ids}-topic`}>主题</label>
        <input id={`${ids}-topic`} value={topic} maxLength={200} placeholder="可选" onChange={event => setTopic(event.target.value)}/></div>
      <div className="ui-field"><label htmlFor={`${ids}-section`}>分组</label>
        <select id={`${ids}-section`} className="jv-select" value={sectionId ?? ""} onChange={event => setSectionId(event.target.value || null)}>
          <option value="">无</option>
          {sections.map(section => <option key={section.id} value={section.id}>{section.name}</option>)}
        </select></div>
      <div className="jv-members">
        <div className="jv-members-head"><span>成员 · {current.length}</span>
          <button type="button" className="ui-button" onClick={() => setPicking(true)}><Icon name="person-add"/>添加成员</button></div>
        {current.map(member => <div key={member.id} className="jv-member-option">
          <MemberAvatar member={member} bots={bots} size={24}/><span className="jv-member-name">{member.name}</span>
          <span className="jv-muted">{member.id === me ? "你" : member.kind === "bot" ? "Bot" : "成员"}</span>
          {member.id !== me && <IconButton icon="close" label={`移除 ${member.name}`} className="jv-member-remove"
            onClick={() => setMemberIds(previous => previous.filter(id => id !== member.id))}/>}
        </div>)}
      </div>
      {error && <p className="jv-form-error" role="alert">{error}</p>}
      <div className="ui-dialog-actions">
        <span className="jv-spacer"/>
        <button type="button" className="ui-button" onClick={onClose}>取消</button>
        <button type="submit" className="ui-button ui-primary" disabled={busy || !name.trim()}>创建</button>
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
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); setBusy(false); }
  }
  async function remove() {
    if (!section || !confirm(`删除分组「${section.name}」？其中的频道会移到「频道」下。`)) return;
    setBusy(true);
    try { await api.deleteSection(section.id); onDeleted?.(section.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除失败"); setBusy(false); }
  }
  return <Modal title={section ? "编辑频道分组" : "新建频道分组"} onClose={onClose}>
    <form onSubmit={event => void save(event)}>
      <div className="ui-field"><label htmlFor={`${ids}-name`}>分组名称</label>
        <input id={`${ids}-name`} value={name} maxLength={80} autoFocus placeholder="新分组" onChange={event => setName(event.target.value)}/></div>
      {error && <p className="jv-form-error" role="alert">{error}</p>}
      <div className="ui-dialog-actions">
        {section && <button type="button" className="ui-button jv-danger" disabled={busy} onClick={() => void remove()}>删除</button>}
        <span className="jv-spacer"/>
        <button type="button" className="ui-button" onClick={onClose}>取消</button>
        <button type="submit" className="ui-button ui-primary" disabled={busy || !name.trim()}>{section ? "保存" : "创建"}</button>
      </div>
    </form>
  </Modal>;
}
