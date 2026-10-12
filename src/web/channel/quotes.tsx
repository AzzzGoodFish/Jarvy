import { useEffect, useState, type ReactNode, type RefObject } from "react";
import type { ChatMessage, Member } from "../api";
import { memberName } from "../members";
import { copyText, Icon, Markdown } from "../ui";
import { linkMentions } from "./mentions";
import type { DraftStore } from "../composer/drafts";

/** Partial quotes (A44). The content marks each quote's place with [[q1]] … [[qN]]; message.quotes holds them in order. */
const MARKER = /\[\[q(\d+)\]\]/g;
const short = (text: string, length = 40) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > length ? `${flat.slice(0, length)}…` : flat; };

/** Plain text for previews: each marker becomes its passage in 「」, as the server's sidebar digests do. */
export function quotedText(message: Pick<ChatMessage, "content" | "quotes">): string {
  return message.content.replace(MARKER, (marker, n: string) => { const quote = message.quotes[Number(n) - 1]; return quote ? `「${quote.text}」` : marker; });
}

/** A message's text: Markdown with @mentions, and each quote marker as a tag that jumps to its source. */
export function MessageText({ message, members, me, onJump }: {
  message: ChatMessage; members: Member[]; me: string; onJump?: (id: string | null, passage: string) => void;
}) {
  // Only markers with a quote behind them are tags; in a message without quotes "[[q1]]" is plain text.
  const text = linkMentions(message.content, members.filter(item => message.mentions.includes(item.id)), me)
    .replace(MARKER, (marker, n: string) => message.quotes[Number(n) - 1] ? `[q${n}](#quote-${n})` : marker);
  const renderQuote = (index: number): ReactNode => {
    const quote = message.quotes[index - 1];
    if (!quote) return null;
    const name = memberName(members.find(member => member.id === quote.senderId));
    return <button type="button" className="jv-quote-tag" title={`${name}：${quote.text}`} data-gone={quote.messageId ? undefined : ""}
      onClick={() => onJump?.(quote.messageId, quote.text)}><Icon name="quote"/><span className="jv-quote-name">{name}：</span><span className="jv-quote-text">{short(quote.text, 80)}</span></button>;
  };
  return <Markdown text={text} renderQuote={renderQuote}/>;
}

/** Highlights the quoted passage inside a message element: whitespace is ignored while matching, and the match is
 * shown with the CSS Custom Highlight API for a moment. False when the passage is not found there. */
export function highlightPassage(element: Element, passage: string): boolean {
  const wanted = passage.replace(/\s+/g, "");
  if (!wanted || typeof CSS === "undefined" || !("highlights" in CSS)) return false;
  const body = element.querySelector(".ui-bubble") ?? element, walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const chars: { node: Text; offset: number }[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest(".jv-quote-tag, button")) continue;
    for (let offset = 0; offset < node.data.length; offset++) if (!/\s/.test(node.data[offset]!)) chars.push({ node, offset });
  }
  const flat = chars.map(char => char.node.data[char.offset]).join(""), at = flat.indexOf(wanted);
  if (at < 0) return false;
  const start = chars[at]!, end = chars[at + wanted.length - 1]!, range = new Range();
  range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset + 1);
  CSS.highlights.set("jv-passage", new Highlight(range));
  setTimeout(() => CSS.highlights.delete("jv-passage"), 2400);
  return true;
}

/** Scrolls to a message and highlights the passage, or flashes the whole message when the passage is not there. */
export function jumpToPassage(element: Element, passage?: string) {
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  if (passage && highlightPassage(element, passage)) return;
  element.classList.add("jv-jump"); setTimeout(() => element.classList.remove("jv-jump"), 1200);
}

/** The composer's quote tags (one per line, removable); their order is the order of [[qN]] when sending. */
export function QuoteTags({ quotes, onRemove }: { quotes: { name: string; text: string }[]; onRemove: (index: number) => void }) {
  if (!quotes.length) return null;
  return <div className="jv-compose-quotes">{quotes.map((quote, index) => <span key={index} className="jv-quote-tag" title={`${quote.name}：${quote.text}`}>
    <Icon name="quote"/><span className="jv-quote-name">{quote.name}：</span><span className="jv-quote-text">{short(quote.text)}</span>
    <button type="button" aria-label={`移除引用：${short(quote.text, 20)}`} onClick={() => onRemove(index)}>×</button></span>)}</div>;
}

/** Selecting text inside one message (desktop) offers 「复制」 and 「在回复中引用」 next to the selection; quoting adds the
 * passage to `chatId`'s draft (`source` finds the message shown there). Selections across messages, of only whitespace,
 * or inside tags and buttons offer nothing. */
export function QuoteSelection({ container, drafts, chatId, source, members, onNotice }: {
  container: RefObject<HTMLElement | null>; drafts: DraftStore; chatId: string; source: (id: string) => ChatMessage | undefined | null; members: Member[]; onNotice: (text: string) => void;
}) {
  const onQuote = (messageId: string, text: string) => {
    const message = source(messageId);
    if (message && !quotePassage(drafts, chatId, message, members, text)) onNotice("一条消息最多引用 10 段");
  };
  const [menu, setMenu] = useState<{ x: number; y: number; messageId: string; text: string } | null>(null);
  useEffect(() => {
    const root = container.current;
    if (!root || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const bodyOf = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest(".ui-bubble");
    const read = () => {
      const selection = getSelection(), text = selection?.toString() ?? "";
      if (!selection || selection.isCollapsed || !text.trim()) { setMenu(null); return; }
      const body = bodyOf(selection.anchorNode), row = body?.closest("[data-message]");
      if (!body || !row || !root.contains(body) || bodyOf(selection.focusNode) !== body || (selection.anchorNode?.parentElement?.closest(".jv-quote-tag, button"))) { setMenu(null); return; }
      const box = selection.getRangeAt(0).getBoundingClientRect();
      setMenu({ x: Math.min(Math.max(box.left + box.width / 2, 90), innerWidth - 90), y: Math.max(box.top - 8, 48), messageId: row.getAttribute("data-message")!, text: text.trim() });
    };
    const up = () => requestAnimationFrame(read), hide = () => setMenu(null);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    const change = () => { if (getSelection()?.isCollapsed) hide(); };
    root.addEventListener("mouseup", up); root.addEventListener("scroll", hide, true); document.addEventListener("keydown", key); document.addEventListener("selectionchange", change);
    return () => { root.removeEventListener("mouseup", up); root.removeEventListener("scroll", hide, true); document.removeEventListener("keydown", key); document.removeEventListener("selectionchange", change); };
  }, [container]);
  if (!menu) return null;
  const done = () => { setMenu(null); getSelection()?.removeAllRanges(); };
  return <div className="ui-popover jv-selection-menu" role="menu" aria-label="选中的文字" style={{ left: menu.x, top: menu.y }} onMouseDown={event => event.preventDefault()}>
    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => { void copyText(menu.text); done(); }}><Icon name="copy"/><span className="ui-menu-copy">复制</span></button>
    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => { onQuote(menu.messageId, menu.text); done(); }}><Icon name="quote"/><span className="ui-menu-copy">在回复中引用</span></button>
  </div>;
}

/** Adds a selected passage to a chat's draft; false when it already holds the 10 a message allows (A44). */
export function quotePassage(drafts: DraftStore, chatId: string, message: ChatMessage, members: Member[], text: string): boolean {
  if (drafts.get(chatId).passages.length >= 10) return false;
  const passage = { messageId: message.id, name: memberName(members.find(member => member.id === message.senderId)), text };
  drafts.update(chatId, draft => ({ passages: [...draft.passages, passage] }));
  return true;
}
