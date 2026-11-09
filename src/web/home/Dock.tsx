import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { ArrowUp, ArrowUpRight, MessageCircle } from "lucide-react";
import type { Bot } from "../../contract/bots";
import type { Chat, ChatMessage } from "../../contract/chat";
import { api } from "../api";
import { previewText } from "../channel/quotes";
import { newKey } from "../composer/drafts";
import { addMessage, replaceMessage, useHeard, type LiveHub } from "../live";
import { t } from "../i18n";

/** How many of the DM's newest messages the box holds; the rest are a click away in the DM. */
const LOADED = 20;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The home page's light chat with the agent Bot (A87): an icon that grows into a message box, with the DM's last
 * messages, about two high, rising over it; older ones are a scroll up and the whole DM is a click away. A reply you
 * have not read is the cat's to show (call.tsx); `opener` lets a click on it open the box. While a line is up beside
 * the cat — the Bot works, its last words linger, the done line — the icon gives way to it, unless the box is open
 * already. Escape, or a click elsewhere with nothing typed, puts the box away. */
export function Dock({ bot, chat, meId, live, speaking, dockRef, opener, onOpenDm, ensureDm, onRead, onSent, onError }: {
  bot: Bot; chat: Chat | undefined; meId: string; live: LiveHub; speaking: boolean; dockRef: RefObject<HTMLDivElement | null>;
  opener: MutableRefObject<(() => void) | null>;
  onOpenDm: () => void;
  /** The DM, created when there is none yet (one per pair). */
  ensureDm: () => Promise<Chat>;
  onRead: (chat: Chat, sequence: number) => void; onSent: (message: ChatMessage) => void; onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<"open" | "closing" | null>(null), [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState(""), [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null), timer = useRef(0);
  /** The message on its way up: sent again unchanged, it keeps its key and the server keeps one message. */
  const pending = useRef<{ text: string; key: string } | null>(null);
  /** Opening: the messages on show rise in. After that only a new one does. */
  const entrance = useRef(false), seen = useRef(new Set<string>());
  const chatId = chat?.id;
  useEffect(() => {
    setMessages([]); seen.current.clear();
    if (!chatId) return;
    let alive = true;
    void api.latestMessages(chatId, LOADED).then(page => { if (alive) setMessages(page.messages); }).catch(onError);
    return () => { alive = false; };
  }, [chatId]);
  useHeard(live, heard => {
    if (heard.kind === "chat" || heard.message.chatId !== chatId) return;
    setMessages(previous => (heard.kind === "message" ? addMessage(previous, heard.message) : replaceMessage(previous, heard.message)).slice(-LOADED));
  });
  // The list is as high as its last two messages and what came between; it keeps the newest at its bottom.
  useLayoutEffect(() => {
    const box = list.current;
    if (!box) return;
    const items = [...box.children] as HTMLElement[], first = items[Math.max(0, items.length - 2)];
    // offsetTop, not the box on screen: the messages may be mid-entrance, moved by their animation.
    box.style.setProperty("--fit", first ? `${Math.ceil(box.scrollHeight - first.offsetTop + 4)}px` : "0px");
    const rising = entrance.current ? items.filter(item => first && item.offsetTop >= first.offsetTop)
      : items.filter(item => !seen.current.has(item.dataset.id!) && seen.current.size > 0);
    if (entrance.current) for (const item of items) item.removeAttribute("data-rise");
    rising.forEach((item, index) => { item.setAttribute("data-rise", ""); item.style.setProperty("--i", String(rising.length - 1 - index)); });
    entrance.current = false;
    seen.current = new Set(items.map(item => item.dataset.id!));
    box.scrollTop = box.scrollHeight;
  }, [messages, state === "open"]);
  // Open, what shows is read.
  const last = messages.at(-1);
  useEffect(() => {
    if (state !== "open" || !chat || !last || (chat.readSequence >= last.sequence && !chat.alerts)) return;
    const mark = () => { if (document.visibilityState === "visible") onRead(chat, last.sequence); };
    mark(); document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [state, last?.sequence, chat?.readSequence, chat?.alerts]);
  function open() {
    clearTimeout(timer.current); entrance.current = true; setState("open");
    setTimeout(() => field.current?.focus({ preventScroll: true }), reduced() ? 0 : 200);
  }
  opener.current = open;
  function close() {
    field.current?.blur(); setState("closing");
    timer.current = window.setTimeout(() => setState(null), reduced() ? 0 : 320);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  // A press elsewhere puts away a box with nothing typed in it; the cat and its line are part of the page's talk.
  useEffect(() => {
    if (state !== "open" || text.trim()) return;
    const away = (event: PointerEvent) => { if (!(event.target as Element).closest?.(".jv-dock, .jv-npc, .jv-home-cat")) close(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [state, text]);
  const ready = !!bot.connectionId;
  async function send() {
    const content = text.trim();
    if (!content || sending || !ready) return;
    const key = pending.current?.text === content ? pending.current.key : newKey();
    pending.current = { text: content, key }; setText(""); setSending(true);
    try {
      const target = chat ?? await ensureDm(), sent = await api.send(target.id, content, [], key);
      pending.current = null;
      setMessages(previous => addMessage(previous, sent).slice(-LOADED)); onSent(sent);
    } catch (error) {
      // Back in the box, in front of anything typed since.
      setText(typed => typed.trim() ? `${content}\n${typed}` : content); onError(error);
    } finally { setSending(false); }
  }
  const shown = state === "open";
  return <div ref={dockRef} className="jv-dock" data-state={state ?? undefined} data-hidden={speaking && !state || undefined}>
    <div className="jv-dock-wrap">
      <div ref={list} className="jv-dock-list" role="log" aria-label={t("home.recent")} aria-hidden={!shown}>
        {messages.map(message => <div key={message.id} data-id={message.id} className="jv-dock-said" data-mine={message.senderId === meId || undefined}>
          <p>{previewText(message)}</p></div>)}
      </div>
    </div>
    <div className="jv-dock-bar">
      <button type="button" className="jv-dock-icon" title={t("home.talk", { name: bot.name })} aria-label={t("home.talk", { name: bot.name })}
        aria-expanded={shown} tabIndex={shown ? -1 : 0} onClick={open}><MessageCircle aria-hidden="true"/></button>
      <div className="jv-dock-input" aria-hidden={!shown}>
        <input ref={field} value={text} disabled={!ready} tabIndex={shown ? 0 : -1} autoComplete="off" enterKeyHint="send"
          placeholder={ready ? t("chat.toBot", { name: bot.name }) : t("chat.pickModel")} aria-label={t("chat.toBot", { name: bot.name })}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
            if (event.key === "Escape") { event.preventDefault(); setText(""); close(); }
          }}/>
        <button type="button" className="jv-dock-go" tabIndex={shown ? 0 : -1} title={t("home.openDm")} aria-label={t("home.openDm")} onClick={onOpenDm}>
          <ArrowUpRight aria-hidden="true"/></button>
        <button type="button" className="jv-dock-send" tabIndex={shown ? 0 : -1} title={t("composer.send")} aria-label={t("composer.send")}
          disabled={!text.trim() || sending || !ready} onClick={() => void send()}><ArrowUp aria-hidden="true"/></button>
      </div>
    </div>
  </div>;
}
