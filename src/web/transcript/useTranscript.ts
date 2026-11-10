import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { api } from "../api";
import { type ChatMessage } from "../../contract/chat";
import { jumpToPassage } from "../channel/quotes";
import { addMessage, joinPage, missingBefore, replaceMessage } from "../live";
import { Hold, placeOf, restorePlace, type ChatMemory, type Place } from "../chat-memory";

const PAGE = 50;

/** The open chat's messages, loaded newest page first; scrolling near the top loads the page before it
 *. Changes heard of are put in place (A72); a gap before a new one is read. Older pages keep the view where it was;
 * new messages are followed when you were at the bottom or sent them. A chat left is remembered as it was, and going
 * back to it shows that at once, where it was left (A79). */
export function useTranscript({ chatId, ready, scroller, me, memory, onError }: {
  chatId: string | null; ready: boolean; scroller: RefObject<HTMLDivElement | null>; me: string; memory: ChatMemory; onError: (error: unknown) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false), [hasOlder, setHasOlder] = useState(false), [loadingOlder, setLoadingOlder] = useState(false);
  const list = useRef(messages), open = useRef(chatId), request = useRef(0), busy = useRef(false), older = useRef(false);
  // The newest message put in since the last render, so a burst of them is not taken for a gap.
  const ahead = useRef(0);
  list.current = messages; open.current = chatId; older.current = hasOlder;
  // After the next render: keep this distance from the bottom (a page was prepended), or jump to the bottom (opened).
  // settled stays false until the jump to the bottom has happened: until then nothing may load older pages (the
  // top sentinel is inside the viewport while the list is still short) and 「at the bottom」 is not believed, because
  // the transcript's height still grows as images and attachments arrive.
  const anchor = useRef<number | null>(null), jump = useRef(false), lastId = useRef<string | undefined>(undefined), atBottom = useRef(true), settled = useRef(false);
  const top = useRef<HTMLDivElement>(null);
  // 「回到最新」: shown while you are away from the bottom; counts others' messages that arrived meanwhile.
  const [away, setAway] = useState(false), seen = useRef(0);
  // Where the reader is, kept as they scroll, and where to go back to after the next render (a remembered chat).
  const place = useRef<Place>({ bottom: true }), restoreTo = useRef<Place | null>(null), [hold] = useState(() => new Hold());
  // A message further back than what was loaded, to go to once the window around it is on screen.
  const goTo = useRef<{ id: string; passage?: string } | null>(null);
  // Being read again (a gap before a new message, a connection that couldn't be told what was missed): until then
  // what is shown isn't kept as it is.
  const reading = useRef(false);

  useEffect(() => {
    setMessages([]); setHasOlder(false);
    settled.current = false; atBottom.current = true; ahead.current = 0; place.current = { bottom: true }; restoreTo.current = null;
    if (!ready || !chatId) return;
    let alive = true; const id = ++request.current;
    setAway(false); seen.current = 0;
    // Leaving: what was on screen is remembered, once it was shown.
    const leave = () => {
      alive = false; hold.release();
      if (settled.current && !reading.current && list.current[0]?.chatId === chatId) memory.keep(chatId, { messages: list.current, hasOlder: older.current, place: place.current, seen: seen.current });
    };
    const kept = memory.take(chatId);
    if (kept) {
      // Back where it was left: its place, or the bottom when it was there or that message is gone.
      jump.current = true; restoreTo.current = kept.place; seen.current = kept.seen;
      setMessages(kept.messages); setHasOlder(kept.hasOlder); setLoading(false);
      return leave;
    }
    setLoading(true);
    // Messages and the end of loading land in one render, so the jump to the bottom sees the rows.
    void api.latestMessages(chatId, PAGE).then(page => {
      if (!alive || id !== request.current) return;
      jump.current = true; setMessages(page.messages); setHasOlder(page.hasOlder); setLoading(false);
    }).catch(error => { if (alive) { setLoading(false); onError(error); } });
    return leave;
  }, [chatId, ready]);

  /** A message of the open chat heard of, new or changed (A72): put in place; read with what is missing before it. */
  function heard(message: ChatMessage, isNew: boolean) {
    if (message.chatId !== open.current) return;
    if (!isNew) { setMessages(previous => replaceMessage(previous, message)); return; }
    const loaded = list.current, newest = Math.max(loaded.at(-1)?.chatId === message.chatId ? loaded.at(-1)!.sequence : 0, ahead.current);
    if (missingBefore(message, newest) && !loaded.some(item => item.id === message.id)) { void refresh(message.chatId).catch(onError); return; }
    ahead.current = Math.max(ahead.current, message.sequence);
    setMessages(previous => addMessage(previous, message));
  }
  /** Reloads what is loaded (from its first message on), so replies, answers and new messages show. */
  async function refresh(id: string) {
    reading.current = true;
    try { await read(id); } finally { reading.current = false; }
  }
  async function read(id: string) {
    const first = list.current[0], r = ++request.current;
    if (!first || first.chatId !== id) {
      // Nothing of it shown yet (this read took over from the opening one): it opens, at the bottom.
      const page = await api.latestMessages(id, PAGE);
      if (open.current === id && r === request.current) { jump.current = true; setMessages(page.messages); setHasOlder(page.hasOlder); setLoading(false); }
      return;
    }
    const after = first.sequence - 1, result = await api.messages(id, after);
    if (open.current !== id || r !== request.current) return;
    // A page prepended meanwhile stays, and so do messages heard of meanwhile.
    setMessages(previous => joinPage(previous.filter(message => message.chatId === id), result.messages, after));
    setLoading(false);
  }
  async function loadOlder() {
    const first = list.current[0], el = scroller.current;
    if (!first || !older.current || busy.current) return;
    busy.current = true; setLoadingOlder(true);
    try {
      const page = await api.olderMessages(first.chatId, first.sequence, PAGE);
      if (open.current !== first.chatId) return;
      anchor.current = el ? el.scrollHeight - el.scrollTop : null;
      setMessages(previous => previous[0]?.id === first.id ? [...page.messages, ...previous] : previous);
      setHasOlder(page.hasOlder);
    } catch (error) { onError(error); }
    finally { busy.current = false; setLoadingOlder(false); }
  }

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Where the reader is, noted after each scroll and each change of layout (a picture loading moves what is seen);
    // not while hidden (a phone showing the list instead) or held, which say nothing about it.
    let frame = 0;
    const note = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (settled.current && el.clientHeight && !hold.on) place.current = placeOf(el, 160); }); };
    // A row can grow after it is on screen (an image or file card finishing its layout), and the transcript itself
    // can shrink (a restored draft makes the composer taller). If we were at the bottom, stay there instead of leaving
    // a gap under the newest message. The transcript's children come and go with loading and paging, so
    // every one of them is watched, not only the first.
    const grown = new ResizeObserver(() => {
      note();
      if (!settled.current) return;
      // Everything fits now (the window grew back): that is the bottom, and no scroll comes to say so.
      if (el.scrollHeight - el.clientHeight < 8) { track(); return; }
      if (!atBottom.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) return; // already there
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    });
    const watch = () => { grown.disconnect(); grown.observe(el); for (const child of el.children) grown.observe(child); };
    watch();
    const children = new MutationObserver(watch);
    children.observe(el, { childList: true });
    const track = () => {
      // While the opening jump is still ahead, the position says nothing: the transcript is short and about to move.
      if (!settled.current) { atBottom.current = true; setAway(false); return; }
      if (hold.on) return;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      setAway(!atBottom.current);
      if (atBottom.current) seen.current = list.current.at(-1)?.sequence ?? 0;
      note();
    };
    track(); el.addEventListener("scroll", track, { passive: true });
    return () => { grown.disconnect(); children.disconnect(); el.removeEventListener("scroll", track); cancelAnimationFrame(frame); };
  }, [scroller.current, chatId]);
  useLayoutEffect(() => {
    const el = scroller.current, last = messages.at(-1);
    if (!el) return;
    if (goTo.current) {
      const { id, passage } = goTo.current, target = el.querySelector(`[data-message="${id}"]`);
      goTo.current = null; restoreTo.current = null; jump.current = false; lastId.current = last?.id;
      if (target) { settled.current = true; atBottom.current = false; setAway(true); jumpToPassage(target, passage); }
      return;
    }
    // The transcript scrolls smoothly by CSS; these two must be instant.
    if (anchor.current !== null) { el.scrollTo({ top: el.scrollHeight - anchor.current, behavior: "instant" }); anchor.current = null; }
    else if (restoreTo.current && messages.length && restorePlace(el, restoreTo.current)) {
      place.current = restoreTo.current; hold.start(el, restoreTo.current);
      restoreTo.current = null; jump.current = false; settled.current = true; atBottom.current = false; setAway(true);
    }
    else if (jump.current && messages.length) {
      restoreTo.current = null;
      // Twice: the rows of this page, then whatever the images in them added by the time it lands.
      const toBottom = () => el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      toBottom(); requestAnimationFrame(toBottom); jump.current = false; settled.current = true; atBottom.current = true;
    }
    else if (last && last.id !== lastId.current && (atBottom.current || last.senderId === me)) { hold.release(); el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }
    lastId.current = last?.id;
    if (atBottom.current) seen.current = last?.sequence ?? 0;
  }, [messages]);
  // Near the top: load the page before. Re-armed after each page, so a short page keeps filling the view.
  useEffect(() => {
    const el = scroller.current, sentinel = top.current;
    if (!el || !sentinel || !hasOlder || !settled.current) return;
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting && settled.current) void loadOlder(); }, { root: el, rootMargin: "400px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlder, messages, chatId, loading]);

  /** Scrolls to a message of this chat (a quote's, a message tag's, a search result's); a partial quote's passage is
   * highlighted in it. One further back than what is loaded loads with a page before it and everything after it, so
   * the transcript still goes on to the newest below it. A message in another chat (a quote in a channel copy of a
   * thread reply points into the thread) is left to the caller, who gets that chat's id. */
  async function toMessage(id: string, passage?: string): Promise<string | undefined> {
    hold.release();
    const known = list.current;
    if (known.some(message => message.id === id)) { jumpTo(id, passage); return; }
    const chatId = open.current, target = await api.message(id);
    if (target.chatId !== chatId) return target.chatId;
    const r = ++request.current;
    const [before, from] = await Promise.all([api.olderMessages(target.chatId, target.sequence, PAGE), api.messages(target.chatId, target.sequence - 1)]);
    if (open.current !== target.chatId || r !== request.current) return;
    const end = from.messages.at(-1)?.sequence ?? target.sequence;
    goTo.current = { id, passage }; ahead.current = 0;
    // Messages heard of meanwhile stay.
    setMessages(previous => [...before.messages, ...from.messages, ...previous.filter(message => message.chatId === target.chatId && message.sequence > end)]);
    setHasOlder(before.hasOlder);
  }
  function jumpTo(id: string, passage?: string) {
    hold.release();
    const el = scroller.current?.querySelector(`[data-message="${id}"]`);
    if (el) jumpToPassage(el, passage);
  }
  const unseen = away ? messages.filter(message => message.sequence > seen.current && message.senderId !== me).length : 0;
  const toLatest = () => { hold.release(); const el = scroller.current; el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); };
  return { messages, setMessages, loading, hasOlder, loadingOlder, refresh, heard, top, away, unseen, toLatest, toMessage, cancel: () => { request.current++; } };
}
