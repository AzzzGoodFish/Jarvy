import { useEffect, useMemo, useRef, useState } from "react";
import type { BotStatus } from "../../api";
import type { FigureMotion } from "../figure";
import type { BotMood } from "../palette";
import { useLiveTurn } from "./live";
import { liveSteps, stepMotion } from "./live-view";
import { pickStep } from "./pick";
import type { NpcDriver } from "./view";

const RECAP_MS = 6000, FADE_MS = 500, STRETCH_MS = 2200, LONG_TURN_MS = 20_000;
/** For this long after a turn a click on the cat brings its line back; later a click just opens Bot info. */
const RECAP_WINDOW_MS = 10 * 60_000;
/** Idle this long, the cat grooms now and then. */
const GROOM_AFTER_MS = 30_000, GROOM_EVERY_MS = 20_000, GROOM_MS = 2800;

/** Drives the cat and its dialogue from a Bot's live turn (A47): what runs picks the motion, `pickStep` the line; a
 * failed step flashes dizzy and shakes; a long turn that completes ends happy with a stretch; the 「done」 line stays
 * 6 s after the last words (a click on the cat within 10 minutes brings it back). With no turn the Bot's status
 * decides (`rest`: asleep when stopped), and an idle cat grooms now and then. */
export function useNpcLive(botId: string | null, chatId: string | null, status: BotStatus | undefined, baseMood: BotMood,
  rest: { motion: FigureMotion; fast: boolean }): NpcDriver {
  const { turn, last, skew } = useLiveTurn(botId);
  const [flash, setFlash] = useState<{ mood: BotMood; until: number } | null>(null), [shake, setShake] = useState(0);
  const [recapUntil, setRecapUntil] = useState(0), [, tick] = useState(0);
  const failed = useRef(new Set<string>()), idleSince = useRef(Date.now());
  const steps = useMemo(() => turn ? liveSteps(turn, chatId) : last ? liveSteps(last, chatId) : [], [turn, last, chatId]);
  // A step that fails: dizzy for a moment, and a shake.
  useEffect(() => {
    for (const step of turn?.steps ?? []) if (step.state === "failed" && !failed.current.has(step.id)) {
      failed.current.add(step.id); setShake(n => n + 1); setFlash({ mood: "dizzy", until: Date.now() + 2600 });
    }
  }, [turn]);
  // A turn ends: the done line after the last words, and for a long turn that completed a happy stretch.
  useEffect(() => {
    if (!last) return;
    failed.current.clear(); idleSince.current = Date.now();
    setRecapUntil(Math.max(Date.now(), pickStep(steps, Date.now(), skew, false).wordsEnd) + RECAP_MS);
    if (last.outcome === "completed" && last.endedAt - last.startedAt > LONG_TURN_MS) setFlash({ mood: "happy", until: Date.now() + 3200 });
  }, [last]);
  useEffect(() => { if (turn) idleSince.current = Date.now(); }, [turn !== null]);
  const now = Date.now(), picked = pickStep(steps, now, skew, turn !== null), shown = picked.shown;
  const running = steps.filter(step => step.state === "running").sort((a, b) => b.startedAt - a.startedAt)[0];
  const stretching = !turn && last?.outcome === "completed" && now + skew - last.endedAt < STRETCH_MS;
  const idleFor = now - idleSince.current, grooming = !turn && status?.status === "idle" && idleFor > GROOM_AFTER_MS && (idleFor - GROOM_AFTER_MS) % GROOM_EVERY_MS < GROOM_MS;
  // The cat does what runs — or what the dialogue still shows, when only thinking runs (a page held a moment after a
  // quick read, facing you while its words are up).
  const motion = running && running.look !== "thought" ? stepMotion(running) : picked.lingering && shown ? stepMotion(shown) : running ? stepMotion(running)
    : turn ? { motion: "think" as const, fast: false } : stretching ? { motion: "stretch" as const, fast: false } : grooming ? { motion: "groom" as const, fast: false } : rest;
  const recap = !turn && !shown && last !== null && now < recapUntil;
  // Timed things end on their own: re-render when the next one runs out (and keep a slow beat for grooming).
  useEffect(() => {
    const at = [flash?.until ?? 0, recapUntil - FADE_MS, recapUntil, (last?.endedAt ?? 0) - skew + STRETCH_MS, picked.next].filter(time => time > Date.now());
    const timer = setTimeout(() => tick(n => n + 1), at.length ? Math.min(...at) - Date.now() + 20 : 1000);
    return () => clearTimeout(timer);
  });
  return {
    view: { steps, shown, skew, startedAt: (turn ?? last)?.startedAt ?? 0, endedAt: turn ? null : last?.endedAt ?? null,
      done: recap ? { ms: last.endedAt - last.startedAt, outcome: last.outcome, fading: now >= recapUntil - FADE_MS } : null },
    motion: motion.motion, fast: motion.fast, mood: flash && flash.until > now ? flash.mood : baseMood, shake,
    canRecap: !turn && last !== null && !recap && now + skew - last.endedAt < RECAP_WINDOW_MS, showRecap: () => setRecapUntil(Date.now() + RECAP_MS),
  };
}
