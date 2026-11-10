import { useState } from "react";
import type { BotStatus } from "../../contract/bots";
import type { Chat } from "../../contract/chat";

/** What the agent Bot has for you (A87), marked over its head as a game marks an NPC with something for the player:
 * a failed run, a question waiting for your answer, a reply you have not read. */
export type Call = "error" | "ask" | "reply";
const SEEN = "jarvy-seen-failure";

/** The agent Bot's call, kept until you deal with it: a failed run until you look at it or the next run starts, a
 * question until it is answered, a reply until it is read. One at a time, in that order. While the Bot works a reply
 * is not marked: the line beside it is saying it. `seen` is looking at the failure; that is kept in the browser. */
export function useCall(status: BotStatus | undefined, dm: Chat | undefined): { call: Call | null; seen: () => void } {
  const failure = status?.error ? `${status.botId}:${status.runId ?? ""}:${status.error}` : null;
  const [seen, setSeen] = useState(() => localStorage.getItem(SEEN));
  const call: Call | null = failure && failure !== seen ? "error" : status?.activity === "asking" ? "ask"
    : dm?.alerts && status?.status !== "running" ? "reply" : null;
  return { call, seen: () => { if (failure) { localStorage.setItem(SEEN, failure); setSeen(failure); } } };
}

/** The strokes of 「!」 and 「?」, each drawn twice: a dark edge, then the colour over it. */
const GLYPH = { mark: "M12 5v14M12 29h0", ask: "M6.5 10a5.5 5.5 0 1 1 8.2 4.8c-1.7 1-2.7 2.1-2.7 3.9v.6M12 29h0" };

/** The mark over the figure's head for its call (home.css). */
export function CallMark({ call }: { call: Call | null }) {
  if (!call) return null;
  const path = call === "ask" ? GLYPH.ask : GLYPH.mark;
  return <span className="jv-call" data-call={call} aria-hidden="true">
    <svg viewBox="0 0 24 36"><path className="jv-call-edge" d={path}/><path d={path}/></svg></span>;
}
