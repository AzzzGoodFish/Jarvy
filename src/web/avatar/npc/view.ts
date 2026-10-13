import type { FigureMotion } from "../figure";
import type { BotMood } from "../palette";

/** What the NPC layer shows, whoever drives it — the scripted demo or a Bot's live turn (A47). Strings are already
 * worded (built while rendering, so they follow the interface language). */
export type Look = "thought" | "mutter" | "speech" | "action";
export type StepIcon = "think" | "mutter" | "read" | "write" | "run" | "script" | "compact" | "retry" | "ask" | "say" | "chat" | "tool";
export interface ViewStep {
  id: string; look: Look; icon: StepIcon; state: "running" | "ok" | "failed"; startedAt: number; endedAt: number | null;
  /** Calls made from inside another tool are indented under it. */
  depth: number;
  /** One line: 「在读 ThreadPane.tsx」, 「npm run build 失败了」. */
  title: string;
  /** What the dialogue says: the thinking or text (shown a sentence at a time), a message, a question. */
  line?: string;
  /** A message or question that went to another chat: 「→ #研发」. */
  to?: string;
  /** A question's options; with a value they can be answered from the dialogue (the demo). */
  options?: { label: string; value?: string }[];
  /** Under a question: where to answer it. */
  hint?: string;
  /** Everything, for the panel: full text, the call's input and output. */
  detail?: string;
}
export interface NpcView {
  steps: ViewStep[];
  /** The step the dialogue shows now, if any. */
  shown: ViewStep | null;
  /** After a turn: how it ended and how long it took, while the line is up (fading for its last half second). */
  done: { ms: number; outcome: "completed" | "interrupted" | "failed"; fading: boolean } | null;
  startedAt: number; endedAt: number | null;
  /** Server clock minus page clock (live turns), for running times. */
  skew: number;
  /** Answers a question from the dialogue (the demo only; a live question is answered on its card). */
  answer?: (value: string) => void;
}
/** One driver of the cat and its dialogue. */
export interface NpcDriver {
  view: NpcView; motion: FigureMotion; fast: boolean; mood: BotMood; shake: number;
  /** A click on the cat brings the last turn's line back (once it has faded). */
  canRecap: boolean; showRecap: () => void;
}

/** Thinking and muttering show like subtitles: only the sentence being written (the last one finished until the
 * next starts). The index changes with each sentence, so the line can fade in anew. */
export function latestSentence(text: string): { index: number; sentence: string } {
  const sentences = text.split(/(?<=[。！？.!?…])\s*/).filter(Boolean);
  return { index: Math.max(0, sentences.length - 1), sentence: sentences.at(-1) ?? "" };
}
