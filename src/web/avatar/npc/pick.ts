import type { ViewStep } from "./view";

/** A finished step stays up a while: words and failures firmly (they show even over what runs next, one after another),
 * a quick tool call and the rest of a murmur lightly (only while nothing but thinking runs). A message also stays as
 * long as it takes to type it out (60 characters a second, 1.5 s at most; `Typed`). */
function linger(step: ViewStep): { firm: number; light: number } {
  const length = step.line?.length ?? 0;
  if (step.look === "speech") { const ms = Math.min(7000, Math.max(2500, 1500 + 50 * length)) + Math.min(1500, length / 0.06); return { firm: ms, light: ms }; }
  if (step.look === "mutter") return { firm: 1500, light: Math.min(3500, Math.max(1500, 800 + 30 * length)) };
  if (step.state === "failed") return { firm: 2000, light: 2000 };
  return { firm: 0, light: step.look === "action" ? 900 : 0 };
}
/** A firm line that would start this long after its step ended is skipped: the dialogue never lags far behind. */
const STALE_MS = 4000;
/** A newer message replaces the line up only once that has been up this long. */
const MIN_MS = 1500;
interface Window { step: ViewStep; start: number; end: number }

/** What the dialogue shows at `now` (page clock; `skew` = server minus page) for a turn's steps: a firm line still up
 * (queued one after another in the order they ended; a newer message cuts the one before short, but not under 1.5 s);
 * a message being sent or a question waiting (after that much of the line before it); whatever runs, unless it is
 * thinking; a light line still up; the running thinking or, while the turn runs, the last step. Also when the picture
 * next changes, and when the last firm line is down (the 「done」 line comes after it). */
export function pickStep(steps: ViewStep[], now: number, skew: number, turnRunning: boolean): { shown: ViewStep | null; lingering: boolean; next: number; wordsEnd: number } {
  const page = (time: number) => time - skew;
  let running: ViewStep | null = null;
  for (const step of steps) if (step.state === "running" && (!running || step.startedAt >= running.startedAt)) running = step;
  const firm: Window[] = [];
  for (const step of steps.filter(item => item.state !== "running" && item.endedAt !== null && linger(item).firm).sort((a, b) => a.endedAt! - b.endedAt!)) {
    const ended = page(step.endedAt!), before = firm.at(-1);
    if (before && step.look === "speech") before.end = Math.min(before.end, Math.max(before.start + MIN_MS, ended));
    const start = Math.max(ended, before?.end ?? 0);
    if (start - ended > STALE_MS) continue;
    firm.push({ step, start, end: start + linger(step).firm });
  }
  // A message being sent or a question waiting comes after the line up (at least 1.5 s of it); lines queued after
  // it started are dropped — it is newer.
  const speaking = running?.look === "speech" ? running : null;
  if (speaking) {
    const from = page(speaking.startedAt);
    for (let index = firm.length - 1; index >= 0; index--) {
      const item = firm[index]!;
      if (item.start >= from && item.start > now) firm.splice(index, 1);
      else if (item.end > from) item.end = Math.max(item.start + MIN_MS, from);
    }
  }
  let light: { step: ViewStep; end: number } | null = null;
  for (const step of steps) {
    if (step.state === "running" || step.endedAt === null || !linger(step).light) continue;
    const end = page(step.endedAt) + linger(step).light;
    if (end > now && (!light || step.endedAt >= light.step.endedAt!)) light = { step, end };
  }
  const window = firm.find(item => item.start <= now && now < item.end);
  const held = window?.step ?? (speaking || (running && running.look !== "thought") ? undefined : light?.step);
  const shown = held ?? speaking ?? running ?? (turnRunning ? steps.at(-1) ?? null : null);
  const times = [...firm.flatMap(item => [item.start, item.end]), light?.end ?? 0].filter(time => time > now);
  // `lingering`: a finished step still up on purpose (not just the last one while the model is asked again).
  return { shown, lingering: !!held, next: times.length ? Math.min(...times) : 0, wordsEnd: firm.at(-1)?.end ?? 0 };
}
