/** Whether the person is looking at Jarvy: its tab is shown and its window is in front (has the focus). Only then
 * does what's on screen count as read; a window left open behind others, or on another screen while you work
 * elsewhere, keeps its messages unread until you come back to it. */
export const inFront = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** Calls `check` whenever the person may have come back (the tab shown, the window in front); returns the unsubscribe. */
export function onFront(check: () => void): () => void {
  document.addEventListener("visibilitychange", check); window.addEventListener("focus", check);
  return () => { document.removeEventListener("visibilitychange", check); window.removeEventListener("focus", check); };
}
