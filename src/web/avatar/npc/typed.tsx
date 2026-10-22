import { useEffect, useRef, useState, type ReactNode } from "react";

/** Characters per millisecond: 60 a second. */
const RATE = 0.06;
const calm = matchMedia("(prefers-reduced-motion: reduce)");

/** Text typed out in the dialogue: what shows chases the text at 60 characters a second, or faster so that
 * what is behind is caught up within `limit` ms (a message 1.5 s, the rest 0.3 s). Streamed text comes a little at a
 * time and looks as before; text that comes in one piece — a tool's line, a message — is typed. Text that changes (a
 * tool's line once it has run) keeps how far it got, so it is not typed twice; a new step or paragraph comes with a new
 * `key` and starts from nothing. The caret blinks while it types, and while `streaming`. Reduced motion shows the text
 * at once. */
export function Typed({ text, limit, streaming = false }: { text: string; limit: number; streaming?: boolean }) {
  const [, tick] = useState(0);
  const state = useRef({ text: "", count: 0, rate: RATE, at: performance.now() }), now = performance.now(), typed = state.current;
  typed.count = Math.min(typed.text.length, typed.count + typed.rate * (now - typed.at)); typed.at = now;
  if (text !== typed.text) { typed.text = text; typed.count = Math.min(typed.count, text.length); typed.rate = Math.max(RATE, (text.length - typed.count) / limit); }
  const typing = !calm.matches && typed.count < text.length;
  useEffect(() => { if (!typing) return; const frame = requestAnimationFrame(() => tick(value => value + 1)); return () => cancelAnimationFrame(frame); });
  // Never half of a surrogate pair (an emoji).
  const shown = typing ? text.slice(0, Math.floor(typed.count)).replace(/[\uD800-\uDBFF]$/, "") : text;
  return <>{shown}{(typing || streaming) && <i className="jv-npc-caret"/>}</>;
}

/** Thinking or a murmur: all of it, up to 12 lines (6 on a phone, npc.css), scrolling. It follows the
 * newest words until it is scrolled back, and again once scrolled to the end; `onReading` says when it is scrolled
 * back. The top fades while there is more above.
 *
 * Only scrolling up stops the following: up from where it last put the text itself. Its own scroll to the end raises a
 * scroll event too, and the text may have grown again before that event is handled; then it is not at the end though
 * nobody scrolled, and it goes to the end again rather than stopping. */
export function Tail({ className, children, onReading }: { className: string; children: ReactNode; onReading: (reading: boolean) => void }) {
  const outer = useRef<HTMLSpanElement>(null), inner = useRef<HTMLSpanElement>(null), told = useRef(onReading);
  const [above, setAbove] = useState(false);
  told.current = onReading;
  useEffect(() => {
    const box = outer.current, text = inner.current;
    if (!box || !text) return;
    let following = true, placed = 0;
    const toEnd = () => { box.scrollTop = box.scrollHeight; placed = box.scrollTop; };
    // The text grows as it is typed, without this rendering again: watch its size.
    const grow = () => { if (following) toEnd(); setAbove(box.scrollTop > 1); };
    const scroll = () => {
      const end = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
      if (end && !following) { following = true; placed = box.scrollTop; told.current(false); }
      else if (!end && following) {
        if (box.scrollTop < placed - 1) { following = false; told.current(true); } else toEnd();
      }
      setAbove(box.scrollTop > 1);
    };
    const observer = new ResizeObserver(grow); observer.observe(text); observer.observe(box); grow();
    box.addEventListener("scroll", scroll, { passive: true });
    return () => { observer.disconnect(); box.removeEventListener("scroll", scroll); told.current(false); };
  }, []);
  return <span ref={outer} className={`${className} jv-npc-tail`} data-above={above || undefined}><span ref={inner}>{children}</span></span>;
}
