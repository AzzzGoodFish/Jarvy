/** How long a live connection may stay silent: the server sends a heartbeat every 15 s, so three missed ones. */
const QUIET_MS = 45_000;
/** Silence after which a page coming back into view doesn't wait for the next check: more than one heartbeat. */
const BACK_MS = 25_000;

/** The page's live events (`/api/events`) on an EventSource that is replaced when it goes quiet. A connection that
 * died while the computer slept or the network changed can stay open in the browser and deliver nothing, and the
 * browser only reconnects on its own when it sees the connection end. So a source that has heard nothing, the
 * heartbeat included, for 45 s is closed and opened again, at once when the page comes back into view after 25 s
 * of silence, and at once when the network comes back. Each opening sends `ready`, on which the page reads again
 * what it shows. Returns how to stop. */
export function liveEvents(url: string, listeners: Record<string, (event: MessageEvent<string>) => void>, onError: () => void): () => void {
  let source: EventSource | undefined, heard = Date.now();
  const open = () => {
    source?.close();
    heard = Date.now();
    const next = new EventSource(url);
    next.addEventListener("heartbeat", () => { heard = Date.now(); });
    for (const [name, listener] of Object.entries(listeners)) next.addEventListener(name, event => { heard = Date.now(); listener(event as MessageEvent<string>); });
    next.onerror = onError;
    source = next;
  };
  const quietFor = (limit: number) => { if (Date.now() - heard > limit) open(); };
  const timer = setInterval(() => quietFor(QUIET_MS), 10_000);
  const shown = () => { if (document.visibilityState === "visible") quietFor(BACK_MS); };
  window.addEventListener("online", open);
  document.addEventListener("visibilitychange", shown);
  window.addEventListener("pageshow", shown);
  open();
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", open);
    document.removeEventListener("visibilitychange", shown);
    window.removeEventListener("pageshow", shown);
    source?.close();
  };
}
