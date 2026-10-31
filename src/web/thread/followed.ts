import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Chat } from "../../contract/chat";
import { compareThreads, type ThreadFilter, type ThreadItem, type ThreadSort } from "../../contract/threads";

/** What changed for 「我关注的线程」 while it is open (A69): a thread had news (its row is fetched again), a thread's
 * pane reported its chat (unread, status, following, title come from it), or the event stream reconnected. */
export type ThreadEvent = { kind: "changed"; id: string } | { kind: "chat"; chat: Chat } | { kind: "reconnected" };
export class ThreadEvents {
  private readonly listeners = new Set<(event: ThreadEvent) => void>();
  emit(event: ThreadEvent) { for (const listener of this.listeners) listener(event); }
  on(listener: (event: ThreadEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

const matches = (thread: ThreadItem, filter: ThreadFilter) => filter === "all" || (filter === "unread" ? thread.unread > 0 : thread.status === filter);
/** Rows by id, the later copy winning, in the list's order. */
const merged = (rows: readonly ThreadItem[], sort: ThreadSort) => [...new Map(rows.map(row => [row.id, row])).values()].sort(compareThreads(sort));

interface Loaded { items: ThreadItem[]; next: string | null; ready: boolean }

/** The followed threads a page at a time, in the tab and order picked (A69). Rows follow the tab live — a thread read
 * in 未读 or finished in 进行中 leaves it — but one unfollowed while the page is open stays, marked, until you leave, in
 * every tab it fits. A live change fetches that one row; a thread that newly fits is placed where it sorts, or left to a
 * later page if it sorts past what is loaded. */
export function useFollowedThreads(events: ThreadEvents, filter: ThreadFilter, sort: ThreadSort) {
  const [loaded, setLoaded] = useState<Loaded>({ items: [], next: null, ready: false });
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  const view = useRef({ filter, sort, generation: 0 }), state = useRef(loaded), kept = useRef(new Map<string, ThreadItem>());
  state.current = loaded;
  const set = (next: Loaded) => { state.current = next; setLoaded(next); };

  async function load(cursor?: string) {
    const generation = view.current.generation;
    setLoading(true); setFailed(false);
    try {
      const page = await api.followedThreads({ filter, sort, cursor });
      if (generation !== view.current.generation) return;
      const current = state.current, edge = page.next ? page.threads.at(-1) : undefined;
      const unfollowed = [...kept.current.values()].filter(row => matches(row, filter) && (!edge || compareThreads(sort)(row, edge) <= 0));
      set({ items: merged([...(cursor ? current.items : []), ...page.threads, ...unfollowed], sort), next: page.next, ready: true });
    } catch { if (generation === view.current.generation) setFailed(true); }
    finally { if (generation === view.current.generation) setLoading(false); }
  }
  useEffect(() => {
    view.current = { filter, sort, generation: view.current.generation + 1 };
    set({ items: [], next: null, ready: false });
    void load();
  }, [filter, sort]);

  // One fetch per thread at a time: news during a fetch asks for one more after it, so the last answer is the newest.
  const inflight = useRef(new Map<string, boolean>());
  function refresh(id: string) {
    if (inflight.current.has(id)) { inflight.current.set(id, true); return; }
    inflight.current.set(id, false);
    const generation = view.current.generation;
    void api.followedThread(id).then(row => place(row, generation), error => {
      if (error instanceof ApiError && error.status === 404 && generation === view.current.generation) set({ ...state.current, items: state.current.items.filter(item => item.id !== id) });
    }).finally(() => { const again = inflight.current.get(id); inflight.current.delete(id); if (again) refresh(id); });
  }
  function place(row: ThreadItem, generation: number) {
    if (generation !== view.current.generation) return;
    remember(row);
    const current = state.current, known = current.items.some(item => item.id === row.id), last = current.items.at(-1);
    const fits = row.following && matches(row, view.current.filter) && (current.next === null || !last || compareThreads(view.current.sort)(row, last) < 0);
    if (known || (current.ready && fits)) set({ ...current, items: merged([...current.items, row], view.current.sort) });
  }
  useEffect(() => events.on(event => {
    if (event.kind === "changed") refresh(event.id);
    else if (event.kind === "reconnected") void reloadFirst();
    else {
      const chat = event.chat, current = state.current, known = current.items.find(item => item.id === chat.id);
      if (!known) { if (chat.following) refresh(chat.id); return; }
      const row = { ...known, title: chat.title, status: chat.status ?? known.status, unread: chat.unread, mentions: chat.mentions, alerts: chat.alerts, following: chat.following };
      remember(row);
      set({ ...current, items: merged([...current.items, row], view.current.sort) });
    }
  }), [events]);
  /** A shown row unfollowed now is kept for this visit; following it again lets it go back to the server's lists. */
  function remember(row: ThreadItem) {
    if (row.following) kept.current.delete(row.id);
    else if (state.current.items.some(item => item.id === row.id)) kept.current.set(row.id, row);
  }
  // After a reconnect: the first page again, over what is loaded; deeper pages keep their place and cursor.
  async function reloadFirst() {
    const generation = view.current.generation;
    const page = await api.followedThreads({ filter: view.current.filter, sort: view.current.sort }).catch(() => null);
    if (!page || generation !== view.current.generation) return;
    const current = state.current, deeper = current.items.length > page.threads.length;
    set({ items: merged([...current.items, ...page.threads], view.current.sort), next: deeper ? current.next : page.next, ready: true });
  }

  return { items: loaded.items.filter(row => matches(row, filter)), find: (id: string | null) => loaded.items.find(row => row.id === id), ready: loaded.ready, more: loaded.next !== null, loading, failed,
    loadMore: () => { if (loaded.next && !loading) void load(loaded.next); }, retry: () => void load(loaded.next ?? undefined) };
}
