import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { ArchiveIcon, BrainIcon, CheckIcon, ChevronRightIcon, FileTextIcon, LoaderCircleIcon, MessageCircleQuestionIcon, MessageSquareTextIcon,
  Minimize2Icon, PencilLineIcon, SquareTerminalIcon, SpeechIcon, XIcon } from "lucide-react";
import { formatNumber, t, type Key } from "../../i18n";
import { NpcToolbar } from "./NpcToolbar";
import { placeBeside } from "./place";
import type { NpcDemo, NpcStep } from "./useNpcDemo";
import "./npc.css";

const ICONS = { think: BrainIcon, mutter: SpeechIcon, read: FileTextIcon, write: PencilLineIcon, run: SquareTerminalIcon, compact: ArchiveIcon,
  ask: MessageCircleQuestionIcon, say: MessageSquareTextIcon };
const seconds = (ms: number) => t("npc.duration", { value: formatNumber(ms / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) });
const chatName = (step: NpcStep) => step.to ? `#${t(step.to)}` : "";
/** The one-line title of a step in its current state: 「在读 ThreadPane.tsx」, 「npm run build 失败了」, 「发到了 #研发」. */
function title(step: NpcStep): string {
  if (step.kind === "think" || step.kind === "mutter") return t(`npc.step.${step.kind}`);
  if (step.kind === "ask" && step.answer) return t("npc.step.ask.ok", { answer: t(step.answer.label) });
  const state = step.state === "failed" && step.kind === "run" ? "failed" : step.state === "running" ? "running" : "ok";
  const kind = step.kind === "say" && step.to ? "post" : step.kind;
  return t(`npc.step.${kind}.${state}` as Key, { target: step.target?.split("/").pop() ?? "", chat: chatName(step) });
}
const streamed = (step: NpcStep) => step.text ? [...t(step.text)].slice(0, step.typed).join("") : "";
/** Thinking shows like subtitles: only the sentence being written (the last one finished until the next starts). */
function latestSentence(text: string): { index: number; sentence: string } {
  const sentences = text.split(/(?<=[。！？.!?…])\s*/).filter(Boolean);
  return { index: Math.max(0, sentences.length - 1), sentence: sentences.at(-1) ?? "" };
}
/** How a step looks in the dialogue: thinking is a thought bubble, the model's own text a murmur, a message a speech box
 * with the Bot's name, a tool or the end of the turn a short action line. */
const LOOK: Record<NpcStep["kind"], "thought" | "mutter" | "speech" | "action"> = {
  think: "thought", mutter: "mutter", say: "speech", ask: "speech", read: "action", write: "action", run: "action", compact: "action",
};

/** The NPC prototype's layer over a DM (`?npc=demo`): an RPG dialogue beside the cat that narrates the turn, opening
 * into a live panel of every step, plus the prototype toolbar. */
export function NpcLayer({ demo, name, cat, area, avoid, layout }: {
  demo: NpcDemo; name: string; cat: RefObject<HTMLElement | null>; area: RefObject<HTMLElement | null>; avoid: RefObject<HTMLElement | null>;
  layout: MutableRefObject<(() => void) | null>;
}) {
  const box = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null), [open, setOpen] = useState(false), [, tick] = useState(0);
  useLayoutEffect(() => {
    layout.current = () => {
      if (!box.current || !cat.current || !area.current) return;
      const rect = area.current.getBoundingClientRect(), bottom = avoid.current ? avoid.current.getBoundingClientRect().top - rect.top : rect.height;
      const bar = toolbar.current?.getBoundingClientRect();
      placeBeside(box.current, cat.current, rect.width, bottom, bar ? { left: bar.left - rect.left, right: bar.right - rect.left, bottom: bar.bottom - rect.top } : null);
    };
    layout.current();
    const observer = new ResizeObserver(() => layout.current?.());
    for (const el of [box.current, toolbar.current]) if (el) observer.observe(el);
    return () => { observer.disconnect(); layout.current = null; };
  }, [open]);
  // Running steps count up while the panel is open.
  const running = demo.steps.some(step => step.state === "running");
  useEffect(() => { if (!open || !running) return; const timer = setInterval(() => tick(n => n + 1), 200); return () => clearInterval(timer); }, [open, running]);
  useEffect(() => { if (!open) return; const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); }; addEventListener("keydown", key); return () => removeEventListener("keydown", key); }, [open]);
  const shown = demo.shown, look = shown ? LOOK[shown.kind] : demo.done ? "action" : null;
  let line: ReactNode = null;
  if (shown?.kind === "think") {
    const { index, sentence } = latestSentence(streamed(shown));
    line = <span key={index} className="jv-npc-thought">{sentence}{shown.state === "running" && <i className="jv-npc-caret"/>}</span>;
  } else if (shown?.kind === "mutter") line = <span className="jv-npc-murmur">{t("npc.mutter", { text: streamed(shown) })}</span>;
  else if (shown?.kind === "say") line = <span className="jv-npc-speech">{streamed(shown)}{shown.state === "running" && <i className="jv-npc-caret"/>}</span>;
  else if (shown?.kind === "ask") line = <span className="jv-npc-speech">{t(shown.question!)}</span>;
  else if (shown) {
    const Icon = ICONS[shown.kind];
    line = <span className="jv-npc-action" data-state={shown.state}><Icon/>{title(shown)}{shown.state === "running" && <i className="jv-npc-dots"/>}</span>;
  } else if (demo.done) line = <span className="jv-npc-action" data-state="ok"><CheckIcon/>{t("npc.done", { duration: seconds(demo.done.ms) })}</span>;
  const expandable = !demo.pose && demo.steps.length > 0;
  return <>
    <NpcToolbar demo={demo} toolbar={toolbar} onReplay={() => { setOpen(false); demo.replay(); }}/>
    <div ref={box} className="jv-npc" data-open={open || undefined} data-look={open ? undefined : look ?? undefined} data-phase={demo.phase}
      data-kind={shown?.kind} data-fading={!open && !shown && demo.done?.fading || undefined} hidden={!open && !line}>
      {open ? <section className="jv-npc-panel" aria-label={t("npc.panel")}>
        <header><strong>{t("npc.panel")}</strong>
          {demo.startedAt > 0 && <span>{seconds((demo.endedAt ?? Date.now()) - demo.startedAt)}</span>}
          <button type="button" onClick={() => setOpen(false)} aria-label={t("npc.collapse")} title={t("npc.collapse")}><Minimize2Icon/></button></header>
        <ol>{demo.steps.map(step => <Step key={step.id} step={step}/>)}</ol>
      </section> : <>
        {look === "speech" && <span className="jv-npc-name">{name}{shown?.to && <em>{t("npc.to", { chat: chatName(shown) })}</em>}</span>}
        {expandable ? <button type="button" className="jv-npc-line" onClick={() => setOpen(true)} title={t("npc.expand")}>{line}</button> : <div className="jv-npc-line">{line}</div>}
        {shown?.kind === "ask" && shown.state === "running" && <div className="jv-npc-options">
          {shown.options!.map(option => <button key={option.value} type="button" onClick={() => demo.answer(option.value)}>{t(option.label)}</button>)}
        </div>}
      </>}
    </div>
  </>;
}

/** One row of the panel: icon, title, state and time; opening it shows the thinking, output or message in full. */
function Step({ step }: { step: NpcStep }) {
  const [open, setOpen] = useState(false), Icon = ICONS[step.kind];
  const detail = step.kind === "ask" ? t(step.question!) : step.text ? streamed(step) : step.output;
  return <li data-state={step.state}>
    <button type="button" aria-expanded={detail ? open : undefined} disabled={!detail} onClick={() => setOpen(value => !value)}>
      <Icon className="jv-npc-kind"/>
      <span className="jv-npc-title">{title(step)}</span>
      <span className="jv-npc-state">{step.state === "running" ? <LoaderCircleIcon/> : step.state === "ok" ? <CheckIcon/> : <XIcon/>}{t(`npc.state.${step.state}`)}</span>
      <span className="jv-npc-time">{seconds((step.endedAt ?? Date.now()) - step.startedAt)}</span>
      {detail && <ChevronRightIcon className="jv-npc-chevron"/>}
    </button>
    {open && detail && <pre data-kind={step.kind}>{detail}</pre>}
  </li>;
}
