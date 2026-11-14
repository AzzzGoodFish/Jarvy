import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Member } from "../../contract/chat";
import { IconButton } from "../ui";
import { memberName } from "../members";
import { t } from "../i18n";
import { previewText } from "./quotes";
import { EmojiPicker } from "./emoji/EmojiPicker";

/** The emoji panel's size with its margin, in CSS pixels (channels.css). */
const PANEL_HEIGHT = 380, PANEL_WIDTH = 310;

/** The quote above a reply: who and what it answers, clicking it jumps to that message. */
export function ReplyQuote({ message, members, onJump }: { message: ChatMessage; members: Member[]; onJump: (id: string) => void }) {
  if (!message.replyTo) return null;
  const author = members.find(member => member.id === message.replyTo!.senderId);
  return <button type="button" className="jv-reply-quote" onClick={() => onJump(message.replyTo!.id)}>
    <span className="jv-reply-author">{memberName(author)}</span>
    <span className="jv-reply-text">{previewText(message.replyTo)}</span>
  </button>;
}

/** How many names a mark shows; the rest are a count, and all of them are in its tooltip. */
const NAMES = 3;

/** Marks under a message: the emoji and who marked it, the same emoji once with everyone's names; clicking toggles your
 * own mark. */
export function ReactionPills({ message, me, members, onReact, onError }: {
  message: ChatMessage; me: string; members: Member[]; onReact: (message: ChatMessage, emoji: string, on: boolean) => void; onError: (error: unknown) => void;
}) {
  if (!message.reactions.length) return null;
  return <div className="jv-reactions">{message.reactions.map(group => {
    const mine = group.memberIds.includes(me), separator = t("common.listSeparator");
    const names = group.memberIds.map(id => memberName(members.find(member => member.id === id))), rest = names.length - NAMES;
    return <button key={group.emoji} type="button" className="jv-reaction" data-mine={mine || undefined} title={names.join(separator)}
      onClick={() => { try { onReact(message, group.emoji, !mine); } catch (error) { onError(error); } }}>
      <span className="jv-reaction-emoji">{group.emoji}</span>
      <span className="jv-reaction-names">{names.slice(0, NAMES).join(separator)}</span>
      {rest > 0 && <span className="jv-reaction-more">{t("reactions.more", { count: rest })}</span>}
    </button>;
  })}</div>;
}

/** Hover actions on a message row: reply, and add an emoji mark. */
export function MessageActions({ message, me, onReply, onReact, onError }: {
  message: ChatMessage; me: string; onReply?: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string, on: boolean) => void; onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false), [up, setUp] = useState(false), [toRight, setToRight] = useState(false), box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<{ top: number; left: number } | null>(null);
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
  // The panel opens where the scroll area has room for it: upward when the last messages sit just above the composer,
  // and towards the bubble — rightward on your own messages, which sit on the right — unless that side is too narrow.
  // An area with room neither way (the home page's light chat, a couple of messages high) would cut it off: there it
  // floats over the page by the button, above it if the window has room. A phone has its own place for it.
  const show = () => {
    const rect = box.current?.getBoundingClientRect(), area = box.current?.closest(".ui-transcript, .ui-pane-body")?.getBoundingClientRect();
    if (rect) {
      const right = (area?.right ?? window.innerWidth) - rect.left, left = rect.right - (area?.left ?? 0);
      const mine = !!box.current?.closest(".ui-user");
      const below = (area?.bottom ?? window.innerHeight) - rect.bottom, above = rect.top - (area?.top ?? 0), rightward = mine ? right >= PANEL_WIDTH || right > left : left < PANEL_WIDTH && right > left;
      setUp(below < PANEL_HEIGHT); setToRight(rightward);
      setOver(below < PANEL_HEIGHT && above < PANEL_HEIGHT && !matchMedia("(max-width: 640px)").matches ? {
        top: rect.top > PANEL_HEIGHT + 8 ? rect.top - PANEL_HEIGHT - 4 : Math.min(rect.bottom + 4, window.innerHeight - PANEL_HEIGHT - 8),
        left: Math.max(8, Math.min(rightward ? rect.left : rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)) } : null);
    }
    setOpen(!open);
  };
  return <div className="jv-message-actions" ref={box}>
    {onReply && <IconButton icon="arrow-u-up-right" label={t("actions.reply")} onClick={() => onReply(message)}/>}
    <IconButton icon="smiley-plus" label={t("actions.react")} aria-expanded={open} onClick={show}/>
    {open && <div className="jv-emoji-menu" role="dialog" aria-label={t("actions.pickEmoji")} data-up={up || undefined} data-right={toRight || undefined}
      style={over ? { position: "fixed", top: over.top, left: over.left, right: "auto", bottom: "auto" } : undefined}
      onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      <EmojiPicker onPick={toggle}/>
    </div>}
  </div>;
}
