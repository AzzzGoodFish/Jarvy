import type { Key } from "../../i18n";
import type { FigureMotion } from "../figure";
import type { BotMood } from "../../../contract/models";

/** One step of the NPC prototype's scripted turn (no server). Thinking and talking to itself (the model's own text,
 * which nobody else sees) are not said to anyone; `say` is a message sent with the chat tool — to you, or to another
 * chat (`to`). */
export type StepKind = "think" | "mutter" | "read" | "write" | "run" | "compact" | "ask" | "say";
export interface ScriptStep {
  kind: StepKind;
  /** File or command the step works on. */
  target?: string;
  /** Streamed text: the thinking, the muttering or the message (a final reply has one per answer). */
  text?: Key;
  replies?: Record<string, Key>;
  /** The other chat a message went to. */
  to?: Key;
  /** The question and its options (ask). */
  question?: Key;
  options?: { value: string; label: Key }[];
  ms?: number;
  failed?: boolean;
  /** What the panel shows when the step is opened: file excerpt, diff, command output. */
  output?: string;
}

const FILE = "src/web/thread/ThreadPane.tsx", BUILD = "npm run build";
const READ = ["export function ThreadPane({ thread, replies }: Props) {", "  const scroll = useRef<HTMLDivElement>(null);", "  useLayoutEffect(() => {",
  "    scroll.current!.scrollTop = scroll.current!.scrollHeight;", "  }, [thread.id]);", "  …"].join("\n");
const FAILED = ["> tsc -p tsconfig.web.json", "src/web/thread/ThreadPane.tsx:58:41 - error TS2345: Argument of type",
  "'HTMLDivElement | null' is not assignable to parameter of type 'HTMLDivElement'.", "", "Found 1 error."].join("\n");
const QUESTION: Pick<ScriptStep, "question" | "options"> = { question: "npc.demo.question", options: [{ value: "yes", label: "npc.demo.yes" }, { value: "no", label: "npc.demo.no" }] };

/** Think → read → think → edit → mutter → build fails → mutter → compact → edit → build passes → post to #dev → ask → reply. */
export const DEMO_TURN: readonly ScriptStep[] = [
  { kind: "think", text: "npc.demo.think1", ms: 4200 },
  { kind: "read", target: FILE, ms: 2600, output: READ },
  { kind: "think", text: "npc.demo.think2", ms: 3800 },
  { kind: "write", target: FILE, ms: 2600, output: ["- useLayoutEffect(() => scrollToEnd(), [thread.id]);", "+ useLayoutEffect(() => {",
    "+   requestAnimationFrame(() => scrollToEnd(scroll.current));", "+ }, [thread.id, replies.length]);"].join("\n") },
  { kind: "mutter", text: "npc.demo.mutter1" },
  { kind: "run", target: BUILD, ms: 3200, failed: true, output: FAILED },
  { kind: "mutter", text: "npc.demo.mutter2" },
  { kind: "compact", ms: 3400, output: "context: 412,380 → 38,210 tokens" },
  { kind: "write", target: FILE, ms: 2000, output: "+   const el = scroll.current; if (el) scrollToEnd(el);" },
  { kind: "run", target: BUILD, ms: 3000, output: ["> vite build", "✓ 2331 modules transformed.", "✓ built in 4.9s"].join("\n") },
  { kind: "say", text: "npc.demo.post", to: "npc.demo.channel" },
  { kind: "ask", ...QUESTION },
  { kind: "say", replies: { yes: "npc.demo.replyYes", no: "npc.demo.replyNo" } },
];

/** The animation buttons (`?npc=demo` toolbar): each holds the cat in one state, with a line in that state's look. */
export interface Pose { key: string; label: Key; motion: FigureMotion; fast?: boolean; mood?: BotMood; step?: ScriptStep; done?: boolean; shake?: boolean; }
export const POSES: readonly Pose[] = [
  { key: "sleep", label: "npc.pose.sleep", motion: "sleep" },
  { key: "idle", label: "npc.pose.idle", motion: "idle" },
  { key: "think", label: "npc.pose.think", motion: "think", step: { kind: "think", text: "npc.demo.think1" } },
  { key: "mutter", label: "npc.pose.mutter", motion: "work", step: { kind: "mutter", text: "npc.demo.mutter2" } },
  { key: "say", label: "npc.pose.say", motion: "turn", step: { kind: "say", text: "npc.demo.replyNo" } },
  { key: "ask", label: "npc.pose.ask", motion: "ask", step: { kind: "ask", ...QUESTION } },
  { key: "read", label: "npc.pose.read", motion: "read", step: { kind: "read", target: FILE } },
  { key: "work", label: "npc.pose.work", motion: "work", fast: true, step: { kind: "run", target: BUILD } },
  { key: "compact", label: "npc.pose.compact", motion: "yawn", step: { kind: "compact" } },
  { key: "busy", label: "npc.pose.busy", motion: "busy" },
  { key: "failed", label: "npc.pose.failed", motion: "idle", mood: "dizzy", shake: true, step: { kind: "run", target: BUILD, failed: true } },
  { key: "done", label: "npc.pose.done", motion: "stretch", mood: "happy", done: true },
  { key: "groom", label: "npc.pose.groom", motion: "groom" },
];
