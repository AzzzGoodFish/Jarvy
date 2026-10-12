import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react";
import type { Bot, Member } from "../api";
import { Icon } from "../ui";
import { MemberAvatar } from "./ChannelView";

/** @-autocomplete for the composer (A37). The menu lists channel members (people and Bots alike); its last row,
 * 「不在本频道中」, opens a side list of everyone else with a search box at the top. Picking someone from there adds
 * them to the channel first. */
export function useMentionMenu({ textarea, value, setValue, inside, outside, bots, onInvite }: {
  textarea: RefObject<HTMLTextAreaElement | null>; value: string; setValue: (value: string) => void;
  inside: Member[]; outside: Member[]; bots: Bot[]; onInvite: (member: Member) => void;
}) {
  const [query, setQuery] = useState<string | null>(null), [active, setActive] = useState(0);
  /** The side list: its search text and highlighted row; null while closed. */
  const [side, setSide] = useState<{ search: string; active: number } | null>(null);
  const box = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  // The caret goes after the inserted name as soon as React commits it, before any further typing lands.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !textarea.current) return;
    textarea.current.focus(); textarea.current.setSelectionRange(caret.current, caret.current); caret.current = null;
  }, [value, textarea]);
  const has = (member: Member, text: string) => member.name.toLowerCase().includes(text.toLowerCase());
  const shown = query === null ? [] : inside.filter(member => has(member, query));
  const others = query === null ? [] : outside.filter(member => has(member, query));
  const found = side ? outside.filter(member => has(member, side.search)) : [];
  const rows = shown.length + (others.length ? 1 : 0);
  const close = () => { setQuery(null); setSide(null); };
  function track(text = value) {
    const el = textarea.current;
    const match = el ? /(?:^|[^\p{Script=Latin}\p{Nd}_])@([^\s@]*)$/u.exec(text.slice(0, el.selectionStart)) : null;
    setQuery(match ? match[1]! : null); setActive(0); setSide(null);
  }
  function pick(member: Member) {
    const el = textarea.current; if (!el) return;
    if (!inside.some(item => item.id === member.id)) onInvite(member);
    const before = value.slice(0, el.selectionStart).replace(/@([^\s@]*)$/u, `@${member.name} `), next = before + value.slice(el.selectionStart);
    caret.current = before.length; setValue(next); close();
  }
  /** Opens the side list, searching for what was typed after @; from the keyboard it takes the focus. */
  function openSide(focus: boolean) {
    if (!side) setSide({ search: query ?? "", active: 0 });
    if (focus) requestAnimationFrame(() => search.current?.focus());
  }
  function backToInput() { setSide(null); textarea.current?.focus(); }
  /** Keys in the composer while the menu is open. True when the key was used by the menu. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!rows || event.nativeEvent.isComposing) return false;
    const onSideRow = active === shown.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((active + (event.key === "ArrowDown" ? 1 : -1) + rows) % rows); setSide(null); return true; }
    if ((event.key === "Enter" || event.key === "Tab") && !onSideRow) { event.preventDefault(); pick(shown[active]!); return true; }
    if ((event.key === "Enter" || event.key === "Tab" || event.key === "ArrowRight") && onSideRow) { event.preventDefault(); openSide(true); return true; }
    if (event.key === "Escape") { event.preventDefault(); close(); return true; }
    return false;
  }
  /** Keys in the side list's search box. */
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (!side || event.nativeEvent.isComposing) return;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && found.length) {
      event.preventDefault(); setSide({ ...side, active: (side.active + (event.key === "ArrowDown" ? 1 : -1) + found.length) % found.length });
    } else if (event.key === "Enter") { event.preventDefault(); if (found[side.active]) pick(found[side.active]!); }
    else if (event.key === "Escape" || (event.key === "ArrowLeft" && !side.search)) { event.preventDefault(); backToInput(); }
  }
  /** The menu closes when the focus leaves both it and the composer. */
  const leaves = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!next || (!box.current?.contains(next) && next !== textarea.current)) close();
  };
  const option = (member: Member, selected: boolean) => <button key={member.id} type="button" role="option" aria-selected={selected} className="ui-menu-item"
    data-active={selected || undefined} onMouseDown={event => { event.preventDefault(); pick(member); }}>
    <MemberAvatar member={member} bots={bots} size={20}/><span className="ui-menu-copy">{member.name}</span><span className="jv-muted">{member.kind === "bot" ? "Bot" : "成员"}</span>
  </button>;
  const menu = rows > 0 ? <div ref={box} className="jv-mention-box" data-side={side ? "" : undefined} onBlur={leaves}>
    <div className="ui-popover jv-mention-menu" role="listbox" aria-label="提及成员">
      {shown.map((member, index) => option(member, index === active))}
      {others.length > 0 && <button type="button" className="ui-menu-item jv-mention-more" aria-haspopup="listbox" aria-expanded={!!side}
        data-active={active === shown.length || undefined} onMouseEnter={() => { setActive(shown.length); openSide(false); }}
        onMouseDown={event => { event.preventDefault(); setActive(shown.length); openSide(true); }}>
        <span className="ui-menu-copy">不在本频道中</span><span className="jv-muted">{others.length}</span><Icon name="chevron-right"/></button>}
    </div>
    {side && <div className="ui-popover jv-mention-side" role="listbox" aria-label="不在本频道中的成员">
      <div className="jv-mention-side-head">
        <button type="button" className="jv-mention-back" aria-label="返回" onMouseDown={event => { event.preventDefault(); backToInput(); }}><Icon name="chevron-left"/></button>
        <input ref={search} type="search" value={side.search} placeholder="搜索成员" aria-label="搜索不在本频道中的成员"
          onChange={event => setSide({ search: event.target.value, active: 0 })} onKeyDown={onSearchKey}/>
      </div>
      <div className="jv-mention-side-list">
        {found.length ? found.map((member, index) => option(member, index === side.active)) : <p className="jv-mention-empty">无匹配成员</p>}
      </div>
      <p className="ui-menu-note ui-small">选中后会拉进本频道</p>
    </div>}
  </div> : null;
  return { menu, track, onKeyDown, close, leaves };
}
