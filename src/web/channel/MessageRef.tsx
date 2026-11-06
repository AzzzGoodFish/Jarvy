import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Popover } from "radix-ui";
import type { Member, MessageRef } from "../../contract/chat";
import { memberName } from "../members";
import { formatClock, formatDay, t } from "../i18n";
import { Icon } from "../ui";
import { previewText } from "./quotes";

/** Where a named message is: its channel, its thread under the channel, or the DM. */
function place(chat: MessageRef["chat"]): string {
  if (chat.type === "dm") return t("ref.dm", { title: chat.title });
  return chat.type === "thread" && chat.parentTitle ? `# ${chat.parentTitle} › ${chat.title}` : `# ${chat.title}`;
}

/** A message a text names by its ID (A82): a tag with who wrote it and how it begins, in place of the ID. With a
 * mouse its preview opens on hover and a click goes to the message; a tap opens the preview, whose button goes there. */
export function MessageRefTag({ target, members, onJump }: { target: MessageRef; members: Member[]; onJump?: () => void }) {
  const [open, setOpen] = useState(false);
  const pointer = useRef(""), timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const name = memberName(members.find(member => member.id === target.senderId)), text = previewText(target);
  const later = (on: boolean, wait: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(on), wait); };
  const hover = (on: boolean) => (event: PointerEvent) => { if (event.pointerType === "mouse") later(on, on ? 350 : 150); };
  const go = () => { window.clearTimeout(timer.current); setOpen(false); onJump?.(); };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="jv-ref-tag" title="" aria-label={t("ref.label", { name, text })}
      onPointerDown={event => { pointer.current = event.pointerType; }} onPointerEnter={hover(true)} onPointerLeave={hover(false)}
      // A mouse click or the keyboard goes to the message; a tap only opens the preview.
      onClick={event => { const touch = pointer.current === "touch" || pointer.current === "pen"; pointer.current = ""; if (!touch && onJump) { event.preventDefault(); go(); } }}>
      <Icon name="chat-bubble"/><span className="jv-quote-name">{t("quote.by", { name })}</span><span className="jv-quote-text">{text}</span>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content className="jv-ref-card jv-ui" side="top" align="start" sideOffset={6} collisionPadding={12}
      onOpenAutoFocus={event => event.preventDefault()} onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
      <div className="jv-ref-place"><span>{place(target.chat)}</span><span>{formatDay(target.createdAt)} {formatClock(target.createdAt)}</span></div>
      <div className="jv-ref-name">{name}</div>
      <p className="jv-ref-text">{text}</p>
      {onJump && <button type="button" className="jv-ref-open" onClick={go}>{t("ref.open")}</button>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
