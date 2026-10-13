import { useEffect, useState } from "react";

/** The turn a Bot is running, as `GET /api/bots/:id/live` sends it (A47). Structure only; `live-view.ts` words it. */
export interface LiveChat { id: string | null; type: "dm" | "channel" | "thread"; title: string; }
export interface LiveInput { path?: string; command?: string; action?: string; chat?: LiveChat; text?: string; options?: string[]; args?: string; }
export interface LiveOutput { head: string; tail: string; omitted: number; }
export interface LiveStep {
  id: string; kind: "thinking" | "text" | "tool" | "compaction" | "retry"; state: "running" | "ok" | "failed"; startedAt: number; endedAt: number | null;
  parentId: string | null; tool?: string; input?: LiveInput; text?: string; omitted?: number; output?: LiveOutput | null;
  tokensBefore?: number | null; tokensAfter?: number | null; attempt?: number; maxAttempts?: number;
}
export interface LiveTurn { startedAt: number; steps: LiveStep[]; dropped: number; }
export type LiveOutcome = "completed" | "interrupted" | "failed";
type Patch = { op: "step"; step: LiveStep } | { op: "text"; id: string; append: string } | { op: "drop"; id: string };
/** The server keeps the latest 4,000 characters of streamed text; the page trims the same way. */
const TEXT = 4000;

export interface LiveState {
  /** The turn running now, or null. */
  turn: LiveTurn | null;
  /** The last turn that ended while the page listened, with how it ended. */
  last: (LiveTurn & { outcome: LiveOutcome; endedAt: number }) | null;
  /** Server clock minus page clock, so running times count from the server's timestamps. */
  skew: number;
}
const EMPTY: LiveState = { turn: null, last: null, skew: 0 };

function apply(turn: LiveTurn, patches: Patch[]): LiveTurn {
  const steps = [...turn.steps];
  let dropped = turn.dropped;
  for (const patch of patches) {
    if (patch.op === "step") {
      const index = steps.findIndex(step => step.id === patch.step.id);
      if (index >= 0) steps[index] = patch.step; else steps.push(patch.step);
    } else if (patch.op === "text") {
      const index = steps.findIndex(step => step.id === patch.id), step = steps[index];
      if (!step) continue;
      const text = (step.text ?? "") + patch.append, over = Math.max(0, text.length - TEXT);
      steps[index] = { ...step, text: text.slice(over), omitted: (step.omitted ?? 0) + over };
    } else { const index = steps.findIndex(step => step.id === patch.id); if (index >= 0) { steps.splice(index, 1); dropped++; } }
  }
  return { ...turn, steps, dropped };
}

/** Follows a Bot's live turn while `botId` is set. A dropped connection reconnects on its own and starts over from the
 * server's snapshot; the last ended turn is kept for the 「done」 line and the panel. */
export function useLiveTurn(botId: string | null): LiveState {
  const [state, setState] = useState<LiveState>(EMPTY);
  useEffect(() => {
    setState(EMPTY);
    if (!botId) return;
    const source = new EventSource(`/api/bots/${encodeURIComponent(botId)}/live`);
    const read = <T,>(event: Event) => JSON.parse((event as MessageEvent<string>).data) as T;
    source.addEventListener("snapshot", event => {
      const data = read<{ turn: LiveTurn | null; now: number }>(event);
      setState(previous => ({ ...previous, turn: data.turn, skew: data.now - Date.now() }));
    });
    source.addEventListener("start", event => { const { turn } = read<{ turn: LiveTurn }>(event); setState(previous => ({ ...previous, turn })); });
    source.addEventListener("patch", event => {
      const { patches } = read<{ patches: Patch[] }>(event);
      setState(previous => previous.turn ? { ...previous, turn: apply(previous.turn, patches) } : previous);
    });
    source.addEventListener("end", event => {
      const { outcome, endedAt } = read<{ outcome: LiveOutcome; endedAt: number }>(event);
      setState(previous => previous.turn ? { ...previous, turn: null, last: { ...previous.turn, outcome, endedAt } } : previous);
    });
    return () => source.close();
  }, [botId]);
  return state;
}
