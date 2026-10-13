import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Member } from "../api";
import { IconButton } from "../ui";
import { memberName } from "../members";
import { t } from "../i18n";

/** The first level of the emoji menu: approval, rejection, right, wrong, then a few moods. */
export const QUICK_EMOJI = ["👍", "👎", "✅", "❌", "😄", "😂", "😵‍💫", "🤔"] as const;
/** The 「更多」 grid: everyday reactions, not a full emoji keyboard. */
export const MORE_EMOJI = [
  "👍", "👎", "✅", "❌", "🙏", "👏", "🎉", "🔥", "💯", "❤️", "💔", "⭐",
  "😄", "😂", "🤣", "😊", "🙂", "😉", "😅", "😴", "🤔", "🤨", "😮", "😱",
  "😢", "😭", "😤", "😡", "🤯", "🥳", "😵‍💫", "🫠", "👀", "🙈", "🤝", "💪",
  "🚀", "🐛", "✅", "⚠️", "❓", "❗", "📌", "🧠", "☕", "🍰", "🌙", "☀️",
] as const;

/** The quote above a reply: who and what it answers, clicking it jumps to that message. */
export function ReplyQuote({ message, members, onJump }: { message: ChatMessage; members: Member[]; onJump: (id: string) => void }) {
  if (!message.replyTo) return null;
  const author = members.find(member => member.id === message.replyTo!.senderId), text = message.replyTo.content.replace(/\s+/g, " ").trim();
  return <button type="button" className="jv-reply-quote" onClick={() => onJump(message.replyTo!.id)}>
    <span className="jv-reply-author">{memberName(author)}</span>
    <span className="jv-reply-text">{text || t("common.attachment")}</span>
  </button>;
}

/** Marks under a message: emoji, count, who (on hover); clicking toggles your own mark. */
export function ReactionPills({ message, me, members, onReact, onError }: {
  message: ChatMessage; me: string; members: Member[]; onReact: (message: ChatMessage, emoji: string, on: boolean) => void; onError: (error: unknown) => void;
}) {
  if (!message.reactions.length) return null;
  return <div className="jv-reactions">{message.reactions.map(group => {
    const mine = group.memberIds.includes(me);
    return <button key={group.emoji} type="button" className="jv-reaction" data-mine={mine || undefined}
      title={group.memberIds.map(id => memberName(members.find(member => member.id === id))).join(t("common.listSeparator"))}
      onClick={() => { try { onReact(message, group.emoji, !mine); } catch (error) { onError(error); } }}>
      <span className="jv-reaction-emoji">{group.emoji}</span><span className="jv-reaction-count">{group.memberIds.length}</span>
    </button>;
  })}</div>;
}

/** Hover actions on a message row: reply, and add an emoji mark. */
export function MessageActions({ message, me, onReply, onReact, onError }: {
  message: ChatMessage; me: string; onReply?: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string, on: boolean) => void; onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false), [up, setUp] = useState(false), box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const toggle = (emoji: string) => {
    const on = !message.reactions.find(group => group.emoji === emoji)?.memberIds.includes(me);
    try { onReact(message, emoji, on); } catch (error) { onError(error); }
    setOpen(false);
  };
  // Opens upward when the scroll area has no room below (the last messages sit just above the composer).
  const show = () => {
    const rect = box.current?.getBoundingClientRect(), area = box.current?.closest(".ui-transcript, .ui-pane-body")?.getBoundingClientRect();
    setUp(!!rect && (area?.bottom ?? window.innerHeight) - rect.bottom < 240); setOpen(!open);
  };
  return <div className="jv-message-actions" ref={box}>
    {onReply && <IconButton icon="arrow-u-up-right" label={t("actions.reply")} onClick={() => onReply(message)}/>}
    <IconButton icon="smiley-plus" label={t("actions.react")} aria-expanded={open} onClick={show}/>
    {open && <div className="jv-emoji-menu" role="menu" aria-label={t("actions.pickEmoji")} data-up={up || undefined}>
      <div className="jv-emoji-quick">{QUICK_EMOJI.map(emoji => <button key={emoji} type="button" role="menuitem" onClick={() => toggle(emoji)}>{emoji}</button>)}</div>
      <details className="jv-emoji-more"><summary>{t("actions.more")}</summary>
        <div className="jv-emoji-grid">{MORE_EMOJI.filter((emoji, index) => MORE_EMOJI.indexOf(emoji) === index).map(emoji =>
          <button key={emoji} type="button" onClick={() => toggle(emoji)}>{emoji}</button>)}</div></details>
    </div>}
  </div>;
}
