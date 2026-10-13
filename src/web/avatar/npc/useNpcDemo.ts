import { useEffect, useRef, useState } from "react";
import { t, type Key } from "../../i18n";
import type { FigureMotion } from "../figure";
import type { BotMood } from "../palette";
import { DEMO_TURN, POSES, type ScriptStep, type StepKind } from "./script";

export type StepState = "running" | "ok" | "failed";
/** A step as it plays: the script entry plus its state, timing and how much of its text is out. */
export interface NpcStep extends Omit<ScriptStep, "ms" | "failed" | "replies"> {
  id: number; state: StepState; startedAt: number; endedAt: number | null; typed: number; answer?: { value: string; label: Key };
}
type Phase = "before" | "turn" | "stretch" | "idle" | "groom";
interface View { steps: NpcStep[]; phase: Phase; startedAt: number; endedAt: number | null; flash: { mood: BotMood; until: number } | null; shake: number; recapUntil: number; }
const FRESH: View = { steps: [], phase: "before", startedAt: 0, endedAt: null, flash: null, shake: 0, recapUntil: 0 };
const TYPE_MS = 40, RECAP_MS = 6000, FADE_MS = 500;
const MOTION: Record<StepKind, FigureMotion> = { think: "think", mutter: "work", read: "read", write: "work", run: "work", compact: "yawn", ask: "ask", say: "turn" };
class Stopped extends Error {}
const fullStep = (step: ScriptStep): NpcStep => ({ ...step, id: -1, state: step.failed ? "failed" : "running", startedAt: Date.now(), endedAt: null,
  typed: step.text ? [...t(step.text)].length : 0 });

/** Plays the scripted turn for the prototype (`?npc=demo`): steps appear and finish on a timer, text streams, a failure
 * flashes dizzy and shakes, a long turn ends happy with a stretch, the 「done」 line fades after 6 s (a click on the cat
 * brings it back), and an idle cat grooms now and then. A pose (the animation buttons) stops the turn and holds one state. */
export function useNpcDemo(enabled: boolean, initialMood: BotMood) {
  const [view, setView] = useState<View>(FRESH), [baseMood, setBaseMood] = useState<BotMood>(initialMood), [round, setRound] = useState(0);
  const [poseKey, setPoseKey] = useState<string | null>(null), [, tick] = useState(0);
  const answer = useRef<((value: string) => void) | null>(null);
  useEffect(() => {
    if (!enabled || poseKey) return;
    let alive = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { timers.delete(timer); if (alive) resolve(); else reject(new Stopped()); }, ms); timers.add(timer);
    });
    const patch = (id: number, change: Partial<NpcStep>) => setView(v => ({ ...v, steps: v.steps.map(step => step.id === id ? { ...step, ...change } : step) }));
    const flash = (mood: BotMood, ms: number) => setView(v => ({ ...v, flash: { mood, until: Date.now() + ms } }));
    // Text comes out a character at a time: over `ms` when given (thinking), else at typing speed.
    const stream = async (id: number, key: Key, ms: number | null) => {
      const length = [...t(key)].length, step = ms ? Math.max(16, ms / length) : TYPE_MS;
      for (let typed = 1; typed <= length; typed++) { patch(id, { typed }); await wait(step); }
    };
    void (async () => {
      setView({ ...FRESH }); await wait(700);
      const start = Date.now(); let chosen = "";
      setView(v => ({ ...v, phase: "turn", startedAt: start }));
      for (const [id, entry] of DEMO_TURN.entries()) {
        const { ms, failed, replies, ...step } = entry, text = replies ? replies[chosen] : entry.text;
        setView(v => ({ ...v, steps: [...v.steps, { ...step, text, id, state: "running", startedAt: Date.now(), endedAt: null, typed: 0 }] }));
        if (entry.kind === "ask") {
          chosen = await new Promise<string>(resolve => { answer.current = resolve; });
          answer.current = null; if (!alive) throw new Stopped();
          patch(id, { state: "ok", endedAt: Date.now(), answer: entry.options!.find(option => option.value === chosen) });
          continue;
        }
        if (text) await stream(id, text, entry.kind === "think" ? ms ?? null : null); else await wait(ms ?? 1000);
        // What was said or muttered stays up a moment before the next step.
        if (entry.kind === "mutter" || entry.kind === "say") await wait(1100);
        patch(id, { state: failed ? "failed" : "ok", endedAt: Date.now() });
        if (failed) { setView(v => ({ ...v, shake: v.shake + 1 })); flash("dizzy", 2600); await wait(900); }
      }
      const end = Date.now();
      setView(v => ({ ...v, phase: "stretch", endedAt: end, recapUntil: end + RECAP_MS }));
      if (end - start > 20_000) flash("happy", 3200);
      await wait(2200);
      for (;;) { setView(v => ({ ...v, phase: "idle" })); await wait(9000); setView(v => ({ ...v, phase: "groom" })); await wait(2800); }
    })().catch(error => { if (!(error instanceof Stopped)) throw error; });
    return () => { alive = false; for (const timer of timers) clearTimeout(timer); answer.current?.(""); };
  }, [enabled, round, poseKey]);
  // A flash and the 「done」 line end on their own: re-render when they run out (the line fades first).
  useEffect(() => {
    const now = Date.now(), at = [view.flash?.until ?? 0, view.recapUntil - FADE_MS, view.recapUntil].filter(time => time > now);
    if (!at.length) return;
    const timer = setTimeout(() => tick(n => n + 1), Math.min(...at) - now + 20);
    return () => clearTimeout(timer);
  });
  const pose = POSES.find(item => item.key === poseKey) ?? null, now = Date.now();
  const current = pose ? null : view.phase === "turn" ? [...view.steps].reverse().find(step => step.state === "running") ?? null : null;
  const motion: FigureMotion = pose ? pose.motion : current ? MOTION[current.kind]
    : view.phase === "stretch" ? "stretch" : view.phase === "groom" ? "groom" : view.phase === "turn" ? "think" : "idle";
  const flashing = view.flash && view.flash.until > now ? view.flash.mood : null;
  const recap = view.endedAt !== null && now < view.recapUntil;
  return {
    ...view, pose, motion, fast: pose ? !!pose.fast : current?.kind === "write" || current?.kind === "run",
    mood: pose?.mood ?? flashing ?? baseMood, baseMood, setBaseMood,
    /** What the dialogue shows: the running step (or the one that just ended, until the next starts), or a pose's line. */
    shown: pose ? pose.step ? fullStep(pose.step) : null : current ?? (view.phase === "turn" ? view.steps.at(-1) ?? null : null),
    /** The 「done」 line after a turn: up for 6 s, fading out for the last half second; a pose shows it with a sample time. */
    done: pose?.done ? { ms: 31_400, fading: false } : !pose && recap ? { ms: view.endedAt! - view.startedAt, fading: now >= view.recapUntil - FADE_MS } : null,
    canRecap: !pose && view.endedAt !== null && !recap,
    showRecap: () => setView(v => ({ ...v, recapUntil: Date.now() + RECAP_MS })),
    answer: (value: string) => answer.current?.(value),
    replay: () => { setPoseKey(null); setRound(n => n + 1); },
    hold: (key: string) => {
      setPoseKey(key);
      setView(v => ({ ...FRESH, shake: v.shake + (POSES.find(item => item.key === key)?.shake ? 1 : 0) }));
    },
  };
}
export type NpcDemo = ReturnType<typeof useNpcDemo>;
