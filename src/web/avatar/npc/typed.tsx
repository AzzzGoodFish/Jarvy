import { useEffect, useRef, useState } from "react";

/** Characters per millisecond: 60 a second. */
const RATE = 0.06;
const calm = matchMedia("(prefers-reduced-motion: reduce)");

/** Text typed out in the dialogue (fish m808): what shows chases the text at 60 characters a second, or faster so that
 * what is behind is caught up within `limit` ms (a message 1.5 s, the rest 0.3 s). Streamed text comes a little at a
 * time and looks as before; text that comes in one piece — a tool's line, a message — is typed. Text that changes (a
 * tool's line once it has run) keeps how far it got, so it is not typed twice; a new step or sentence comes with a new
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
