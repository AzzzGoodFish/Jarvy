import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { api, type ChatMessage } from "../api";

const PAGE = 50;

/** The open chat's messages, loaded newest page first; scrolling near the top loads the page before it
 *. Updates reload only the loaded window. Older pages keep the view where it was; new
 * messages are followed when you were at the bottom or sent them. */
export function useTranscript({ chatId, ready, scroller, me, onError }: {
  chatId: string | null; ready: boolean; scroller: RefObject<HTMLDivElement | null>; me: string; onError: (error: unknown) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false), [hasOlder, setHasOlder] = useState(false), [loadingOlder, setLoadingOlder] = useState(false);
  const list = useRef(messages), open = useRef(chatId), request = useRef(0), busy = useRef(false), older = useRef(false);
  list.current = messages; open.current = chatId; older.current = hasOlder;
  // After the next render: keep this distance from the bottom (a page was prepended), or jump to the bottom (opened).
  const anchor = useRef<number | null>(null), jump = useRef(false), lastId = useRef<string | undefined>(undefined), atBottom = useRef(true);
  const top = useRef<HTMLDivElement>(null);
  // 「回到最新」: shown while you are away from the bottom; counts others' messages that arrived meanwhile.
  const [away, setAway] = useState(false), seen = useRef(0);

  useEffect(() => {
    setMessages([]); setHasOlder(false);
    if (!ready || !chatId) return;
    let alive = true; const id = ++request.current;
    setLoading(true);
    // Messages and the end of loading land in one render, so the jump to the bottom sees the rows.
    void api.latestMessages(chatId, PAGE).then(page => {
      if (!alive || id !== request.current) return;
      jump.current = true; setMessages(page.messages); setHasOlder(page.hasOlder); setLoading(false);
    }).catch(error => { if (alive) { setLoading(false); onError(error); } });
    return () => { alive = false; };
  }, [chatId, ready]);

  /** Reloads what is loaded (from its first message on), so replies, answers and new messages show. */
  async function refresh(id: string) {
    const first = list.current[0], r = ++request.current;
    if (!first || first.chatId !== id) {
      const page = await api.latestMessages(id, PAGE);
      if (open.current === id && r === request.current) { setMessages(page.messages); setHasOlder(page.hasOlder); setLoading(false); }
      return;
    }
    const after = first.sequence - 1, result = await api.messages(id, after);
    if (open.current !== id || r !== request.current) return;
    // A page prepended meanwhile stays.
    setMessages(previous => [...previous.filter(message => message.chatId === id && message.sequence <= after), ...result.messages]);
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
    const track = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      setAway(!atBottom.current);
      if (atBottom.current) seen.current = list.current.at(-1)?.sequence ?? 0;
    };
    track(); el.addEventListener("scroll", track, { passive: true });
    return () => el.removeEventListener("scroll", track);
  }, [scroller.current, chatId]);
  useLayoutEffect(() => {
    const el = scroller.current, last = messages.at(-1);
    if (!el) return;
    // The transcript scrolls smoothly by CSS; these two must be instant.
    if (anchor.current !== null) { el.scrollTo({ top: el.scrollHeight - anchor.current, behavior: "instant" }); anchor.current = null; }
    else if (jump.current && messages.length) { el.scrollTo({ top: el.scrollHeight, behavior: "instant" }); jump.current = false; atBottom.current = true; }
    else if (last && last.id !== lastId.current && (atBottom.current || last.senderId === me)) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    lastId.current = last?.id;
    if (atBottom.current) seen.current = last?.sequence ?? 0;
  }, [messages]);
  // Near the top: load the page before. Re-armed after each page, so a short page keeps filling the view.
  useEffect(() => {
    const el = scroller.current, sentinel = top.current;
    if (!el || !sentinel || !hasOlder) return;
    const observer = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) void loadOlder(); }, { root: el, rootMargin: "400px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlder, messages, chatId]);

  /** Loads a window ending at a message, then scrolls to it (a reply's quote). */
  async function toMessage(id: string) {
    const known = list.current;
    if (known.some(message => message.id === id)) { jumpTo(id); return; }
    const target = await api.message(id);
    const page = await api.olderMessages(target.chatId, target.sequence + 1, PAGE);
    if (open.current !== target.chatId) return;
    jump.current = true; setMessages([...page.messages, target]); setHasOlder(page.hasOlder);
    requestAnimationFrame(() => jumpTo(id));
  }
  function jumpTo(id: string) {
    const el = scroller.current?.querySelector(`[data-message="${id}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.classList.add("jv-jump");
    setTimeout(() => el?.classList.remove("jv-jump"), 1200);
  }
  const unseen = away ? messages.filter(message => message.sequence > seen.current && message.senderId !== me).length : 0;
  const toLatest = () => { const el = scroller.current; el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); };
  return { messages, setMessages, loading, hasOlder, loadingOlder, refresh, top, away, unseen, toLatest, toMessage, cancel: () => { request.current++; } };
}
