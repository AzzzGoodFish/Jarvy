import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Bot, Member } from "../api";
import { MemberAvatar } from "./ChannelView";

/** @-autocomplete for the composer (A37): channel members first (people and Bots alike), then people outside
 * the channel; picking one of those adds them to the channel first. */
export function useMentionMenu({ textarea, value, setValue, inside, outside, bots, onInvite }: {
  textarea: RefObject<HTMLTextAreaElement | null>; value: string; setValue: (value: string) => void;
  inside: Member[]; outside: Member[]; bots: Bot[]; onInvite: (member: Member) => void;
}) {
  const [query, setQuery] = useState<string | null>(null), [active, setActive] = useState(0);
  // The caret goes after the inserted name as soon as React commits it, before any further typing lands.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !textarea.current) return;
    textarea.current.focus(); textarea.current.setSelectionRange(caret.current, caret.current); caret.current = null;
  }, [value, textarea]);
  const matches = (member: Member) => query !== null && member.name.toLowerCase().includes(query.toLowerCase());
  const shownInside = inside.filter(matches), shownOutside = outside.filter(matches), options = [...shownInside, ...shownOutside];
  function track(text = value) {
    const el = textarea.current;
    const match = el ? /(?:^|[^\p{Script=Latin}\p{Nd}_])@([^\s@]*)$/u.exec(text.slice(0, el.selectionStart)) : null;
    setQuery(match ? match[1]! : null); setActive(0);
  }
  function pick(member: Member) {
    const el = textarea.current; if (!el) return;
    if (!inside.some(item => item.id === member.id)) onInvite(member);
    const before = value.slice(0, el.selectionStart).replace(/@([^\s@]*)$/u, `@${member.name} `), next = before + value.slice(el.selectionStart);
    caret.current = before.length; setValue(next); setQuery(null);
  }
  /** True when the key was used by the menu. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!options.length || event.nativeEvent.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); return true; }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(options[active]!); return true; }
    if (event.key === "Escape") { event.preventDefault(); setQuery(null); return true; }
    return false;
  }
  const menu = options.length > 0 ? <div className="ui-popover jv-mention-menu" role="listbox" aria-label="提及成员">
    {options.map((member, index) => <div key={member.id}>
      {index === shownInside.length && <div className="ui-menu-note ui-small">不在频道中</div>}
      <button type="button" role="option" aria-selected={index === active} className="ui-menu-item" data-active={index === active || undefined}
        data-outside={index >= shownInside.length || undefined} onMouseDown={event => { event.preventDefault(); pick(member); }}>
        <MemberAvatar member={member} bots={bots} size={20}/><span className="ui-menu-copy">{member.name}</span><span className="jv-muted">{member.kind === "bot" ? "Bot" : "成员"}</span>
      </button>
    </div>)}
  </div> : null;
  return { menu, track, onKeyDown, close: () => setQuery(null) };
}
