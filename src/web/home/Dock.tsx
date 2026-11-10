import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { ArrowUpRight, MessageCircle } from "lucide-react";
import type { Bot } from "../../contract/bots";
import type { Attachment, Chat, ChatMessage, Member } from "../../contract/chat";
import { api } from "../api";
import { ChatMemory } from "../chat-memory";
import { QuoteSelection } from "../channel/quotes";
import { Composer } from "../composer/Composer";
import { quoteMessage, useDraft, type DraftStore } from "../composer/drafts";
import { DmMessages } from "../dm/DmMessages";
import { useHeard, type LiveHub } from "../live";
import { useTranscript } from "../transcript/useTranscript";
import { t } from "../i18n";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** A press here doesn't put the box away: the box, the cat and its line, and what opens from the box's messages. */
const INSIDE = ".jv-dock, .jv-npc, .jv-home-cat, .ui-popover, dialog, [role=dialog]";
/** Open over the box, Escape is theirs: an emoji picker, a selection's menu, a picture's preview. */
const OVER = ".jv-emoji-menu, .ui-popover, dialog[open], [role=dialog]";

/** The home page's light chat with the agent Bot (A87): an icon that grows into the DM's own message input (the shared
 * composer), with the DM's messages as the DM shows them rising over it, about two high and older ones a scroll up; the
 * whole DM is a click away. The icon is always there, while the Bot works too. A reply you have not read is the cat's to
 * show (call.tsx); `opener` lets a click on it open the box. Escape, or a click elsewhere with nothing in the draft, puts
 * the box away; the draft is the DM's, kept like any other. */
export function Dock({ bot, chat, meId, members, drafts, live, dockRef, opener, onOpenDm, ensureDm, onRead, onSent, onPreview, onNotice, onError }: {
  bot: Bot; chat: Chat | undefined; meId: string; members: Member[]; drafts: DraftStore; live: LiveHub; dockRef: RefObject<HTMLDivElement | null>;
  opener: MutableRefObject<(() => void) | null>;
  onOpenDm: () => void;
  /** The DM, created when there is none yet (one per pair). */
  ensureDm: () => Promise<Chat>;
  onRead: (chat: Chat, sequence: number) => void; onSent: (message: ChatMessage) => void;
  onPreview: (files: Attachment[], index: number) => void; onNotice: (text: string) => void; onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<"open" | "closing" | null>(null), timer = useRef(0);
  const log = useRef<HTMLDivElement>(null), [memory] = useState(() => new ChatMemory());
  const chatId = chat?.id ?? null, shown = state === "open";
  // Read while it shows, from the newest page; each opening reads it afresh.
  const history = useTranscript({ chatId, ready: state !== null, scroller: log, me: meId, memory, onError });
  const { messages, setMessages } = history;
  useHeard(live, heard => {
    if (heard.kind === "reconnected") { if (state && chatId) void history.refresh(chatId).catch(onError); return; }
    if (heard.kind !== "chat" && state) history.heard(heard.message, heard.kind === "message");
  });
  // As high as its last two messages and what came between, up to a part of the screen; a scroll up for the rest.
  useLayoutEffect(() => {
    const box = log.current;
    if (!box) return;
    const rows = box.querySelectorAll<HTMLElement>(":scope > [data-message]"), first = rows[Math.max(0, rows.length - 2)];
    box.style.setProperty("--fit", first ? `${Math.ceil(box.scrollHeight - first.offsetTop + 8)}px` : "0px");
  }, [messages, shown]);
  // Open, what shows is read.
  const last = messages.at(-1);
  useEffect(() => {
    if (!shown || !chat || !last || (chat.readSequence >= last.sequence && !chat.alerts)) return;
    const mark = () => { if (document.visibilityState === "visible") onRead(chat, last.sequence); };
    mark(); document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [shown, last?.sequence, chat?.readSequence, chat?.alerts]);
  function open() {
    clearTimeout(timer.current); memory.clear(); setState("open");
    if (!chat) void ensureDm().catch(onError);
    setTimeout(() => dockRef.current?.querySelector("textarea")?.focus({ preventScroll: true }), reduced() ? 0 : 200);
  }
  opener.current = open;
  function close() {
    (document.activeElement as HTMLElement | null)?.blur?.(); setState("closing");
    timer.current = window.setTimeout(() => setState(null), reduced() ? 0 : 320);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  const draft = useDraft(drafts, chatId ?? ""), empty = !draft.text?.trim() && !draft.files.length && !draft.quote && !draft.passages.length;
  useEffect(() => {
    if (!shown || !empty) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest?.(INSIDE)) close(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [shown, empty]);
  async function send(content: string, attachmentIds: string[], key: string, replyTo?: string, quotes?: { messageId: string; text: string }[]) {
    const target = chat ?? await ensureDm(), sent = await api.send(target.id, content, attachmentIds, key, false, replyTo, quotes);
    history.heard(sent, true); onSent(sent);
  }
  const update = (updated: ChatMessage) => setMessages(previous => previous.map(item => item.id === updated.id ? { ...item, ...updated } : item));
  async function react(message: ChatMessage, emoji: string, on: boolean) {
    try { const updated = await api.react(message.id, emoji, on); update({ ...message, reactions: updated.reactions }); } catch (error) { onError(error); }
  }
  async function fold(message: ChatMessage, folded: boolean) {
    try { const updated = await api.fold(message.id, folded); update({ ...message, folded: updated.folded }); } catch (error) { onError(error); }
  }
  const jump = (id: string | null, passage?: string) => id ? void history.toMessage(id, passage).catch(() => onNotice(t("app.sourceGone"))) : onNotice(t("app.sourceGone"));
  const activeQuestion = shown ? [...messages].reverse().find(message => message.question?.state === "pending")?.id : undefined;
  const ready = !!bot.connectionId;
  return <div ref={dockRef} className="jv-dock" data-state={state ?? undefined}
    onKeyDown={event => { if (event.key === "Escape" && shown && !event.defaultPrevented && !document.querySelector(OVER)) { event.preventDefault(); close(); } }}>
    <div className="jv-dock-wrap">
      <div ref={log} className="ui-transcript jv-dock-log" role="log" aria-label={t("home.recent")} aria-hidden={!shown}>
        {history.hasOlder && <div ref={history.top} className="jv-history-more" aria-live="polite">{history.loadingOlder ? t("chat.loadingOlder") : ""}</div>}
        <DmMessages messages={messages} members={members} me={meId} activeQuestion={activeQuestion} bot={bot}
          onSettled={update} onPreview={onPreview} onQuote={message => quoteMessage(drafts, message, members)} onReact={(message, emoji, on) => void react(message, emoji, on)}
          onFold={(message, folded) => void fold(message, folded)} onJump={jump} onError={onError}/>
      </div>
    </div>
    <div className="jv-dock-bar">
      <button type="button" className="jv-dock-icon" title={t("home.talk", { name: bot.name })} aria-label={t("home.talk", { name: bot.name })}
        aria-expanded={shown} tabIndex={shown ? -1 : 0} onClick={open}><MessageCircle aria-hidden="true"/></button>
      <div className="jv-dock-input" aria-hidden={!shown} inert={!shown}>
        {chat && <Composer chatId={chat.id} id="jv-dock-composer" drafts={drafts} scrollRef={log} disabled={!ready}
          placeholder={ready ? t("chat.toBot", { name: bot.name }) : t("chat.pickModel")} onSend={send} onError={onError} onNotice={onNotice}
          extra={<button type="button" className="jv-dock-go" title={t("home.openDm")} aria-label={t("home.openDm")} onClick={onOpenDm}><ArrowUpRight aria-hidden="true"/></button>}/>}
      </div>
    </div>
    {chat && shown && <QuoteSelection container={log} drafts={drafts} chatId={chat.id} source={id => messages.find(message => message.id === id)} members={members} onNotice={onNotice}/>}
  </div>;
}
