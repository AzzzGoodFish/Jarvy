import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { ArchiveIcon, BrainIcon, CheckIcon, ChevronRightIcon, CodeXmlIcon, FileTextIcon, LoaderCircleIcon, MessageCircleQuestionIcon, MessageSquareTextIcon,
  MessagesSquareIcon, Minimize2Icon, PencilLineIcon, RefreshCwIcon, SquareTerminalIcon, SpeechIcon, WrenchIcon, XIcon } from "lucide-react";
import { formatNumber, t } from "../../i18n";
import { placeBeside } from "./place";
import { type NpcView, type StepIcon, type ViewStep } from "./view";
import { Tail, Typed } from "./typed";
import "./npc.css";

const ICONS: Record<StepIcon, typeof BrainIcon> = { think: BrainIcon, mutter: SpeechIcon, read: FileTextIcon, write: PencilLineIcon, run: SquareTerminalIcon,
  script: CodeXmlIcon, compact: ArchiveIcon, retry: RefreshCwIcon, ask: MessageCircleQuestionIcon, say: MessageSquareTextIcon, chat: MessagesSquareIcon, tool: WrenchIcon };
const seconds = (ms: number) => t("npc.duration", { value: formatNumber(Math.max(0, ms) / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) });
const DONE = { completed: "npc.done", interrupted: "npc.done.interrupted", failed: "npc.done.failed" } as const;

/** The NPC layer over a DM: an RPG dialogue beside the cat in four looks — a thought bubble for thinking, a murmur for
 * the model's own text, a named speech box for messages, a pill for tools and the end of a turn — opening into a live
 * panel of every step. `toolbar` is the prototype's (`?npc=demo`); `onPanel` closes the panel from it. */
export function NpcLayer({ view, name, cat, area, avoid, layout, facing, toolbar }: {
  view: NpcView; name: string; cat: RefObject<HTMLElement | null>; area: RefObject<HTMLElement | null>; avoid: RefObject<HTMLElement | null>;
  layout: MutableRefObject<(() => void) | null>; facing: () => number;
  toolbar?: (bar: RefObject<HTMLDivElement | null>, closePanel: () => void) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null), bar = useRef<HTMLDivElement>(null), [open, setOpen] = useState(false), [, tick] = useState(0);
  useLayoutEffect(() => {
    layout.current = () => {
      if (!box.current || !cat.current || !area.current) return;
      const rect = area.current.getBoundingClientRect(), bottom = avoid.current ? avoid.current.getBoundingClientRect().top - rect.top : rect.height;
      const edge = bar.current?.getBoundingClientRect();
      // A collapsed dialogue fits the room beside the cat; the panel keeps its own width.
      if (!open) box.current.setAttribute("data-fit", ""); else box.current.removeAttribute("data-fit");
      placeBeside(box.current, cat.current, rect.width, bottom, edge ? { left: edge.left - rect.left, right: edge.right - rect.left, bottom: edge.bottom - rect.top } : null, facing());
    };
    layout.current();
    const observer = new ResizeObserver(() => layout.current?.());
    for (const el of [box.current, bar.current]) if (el) observer.observe(el);
    return () => { observer.disconnect(); layout.current = null; };
  }, [open]);
  // Running steps count up while the panel is open.
  const running = view.steps.some(step => step.state === "running");
  useEffect(() => { if (!open || !running) return; const timer = setInterval(() => tick(n => n + 1), 200); return () => clearInterval(timer); }, [open, running]);
  useEffect(() => { if (!open) return; const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); }; addEventListener("keydown", key); return () => removeEventListener("keydown", key); }, [open]);
  // The panel closes when the first step changes: another turn, or none.
  const first = view.steps[0]?.id;
  useEffect(() => { setOpen(false); }, [first]);
  // While the pointer is on the dialogue or its text is scrolled back, it keeps the step it shows: the
  // step still updates, the next one waits.
  const [hover, setHover] = useState(false), [reading, setReading] = useState(false), [pin, setPin] = useState<string | null>(null);
  const holding = hover || reading;
  useEffect(() => { setPin(holding ? view.shown?.id ?? null : null); }, [holding]);
  const shown = (pin && view.steps.find(step => step.id === pin)) || view.shown, look = shown ? shown.look : view.done ? "action" : null;
  let line: ReactNode = null;
  // Every line is typed out (`Typed`): streamed words as they come, a tool's line or a message that comes in
  // one piece over a moment. A new step types from the start. Thinking and murmurs show all of the step's text, its
  // paragraphs a blank line apart, scrolling (`Tail`).
  if (shown?.look === "thought" || shown?.look === "mutter") {
    const whole = (shown.line ?? "").replace(/\n\s*\n\s*/g, "\n\n").trim();
    const typed = <Typed key={shown.id} text={whole} limit={300} streaming={shown.look === "thought" && shown.state === "running"}/>;
    const [before, after] = t("npc.mutter", { text: "\u0001" }).split("\u0001");
    line = <Tail key={shown.id} className={shown.look === "thought" ? "jv-npc-thought" : "jv-npc-murmur"} onReading={setReading}>
      {shown.look === "thought" ? typed : <>{before}{typed}{after}</>}</Tail>;
  } else if (shown?.look === "speech") line = <span className="jv-npc-speech"><Typed key={shown.id} text={shown.line ?? ""} limit={1500} streaming={shown.state === "running" && shown.icon === "say"}/></span>;
  else if (shown) {
    const Icon = ICONS[shown.icon];
    line = <span className="jv-npc-action" data-state={shown.state}><Icon/><Typed key={shown.id} text={shown.title} limit={300}/>{shown.state === "running" && <i className="jv-npc-dots"/>}</span>;
  } else if (view.done) line = <span className="jv-npc-action" data-state={view.done.outcome === "completed" ? "ok" : "failed"}>
    {view.done.outcome === "completed" ? <CheckIcon/> : <XIcon/>}<Typed key={`done:${view.done.ms}`} text={t(DONE[view.done.outcome], { duration: seconds(view.done.ms) })} limit={300}/></span>;
  const expandable = view.steps.length > 0, asking = shown?.icon === "ask" && shown.state === "running";
  // A hidden dialogue gets no pointer leave.
  useEffect(() => { if (!line) setHover(false); }, [!line]);
  return <>
    {toolbar?.(bar, () => setOpen(false))}
    <div ref={box} className="jv-npc" data-open={open || undefined} data-look={open ? undefined : look ?? undefined} data-kind={shown?.icon}
      data-fading={!open && !shown && view.done?.fading || undefined} hidden={!open && !line}
      onPointerEnter={event => { if (event.pointerType === "mouse") setHover(true); }} onPointerLeave={() => setHover(false)}>
      {open ? <section className="jv-npc-panel" aria-label={t("npc.panel")}>
        <header><strong>{t("npc.panel")}</strong>
          {view.startedAt > 0 && <span>{seconds((view.endedAt ?? Date.now() + view.skew) - view.startedAt)}</span>}
          <button type="button" onClick={() => setOpen(false)} aria-label={t("npc.collapse")} title={t("npc.collapse")}><Minimize2Icon/></button></header>
        <ol>{view.steps.map(step => <Step key={step.id} step={step} skew={view.skew}/>)}</ol>
      </section> : <>
        {look === "speech" && <span className="jv-npc-name">{name}{shown?.to && <em>{t("npc.to", { chat: shown.to })}</em>}</span>}
        {/* Not a <button>: the text inside scrolls, which buttons do not allow everywhere. */}
        {expandable ? <div role="button" tabIndex={0} className="jv-npc-line" onClick={() => setOpen(true)} title={t("npc.expand")}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); } }}>{line}</div> : <div className="jv-npc-line">{line}</div>}
        {asking && view.answer && shown.options?.some(option => option.value) && <div className="jv-npc-options">
          {shown.options.map(option => <button key={option.label} type="button" onClick={() => view.answer!(option.value!)}>{option.label}</button>)}
        </div>}
        {asking && !view.answer && shown.hint && <p className="jv-npc-hint">{shown.hint}</p>}
      </>}
    </div>
  </>;
}

/** One row of the panel: icon, title, state and time; opening it shows the thinking, the call's input and output, the
 * message. Calls made from inside a tool sit indented under it. */
function Step({ step, skew }: { step: ViewStep; skew: number }) {
  const [open, setOpen] = useState(false), Icon = ICONS[step.icon], detail = step.detail;
  return <li data-state={step.state} style={step.depth ? { paddingLeft: `${step.depth * 16}px` } : undefined}>
    <button type="button" aria-expanded={detail ? open : undefined} disabled={!detail} onClick={() => setOpen(value => !value)}>
      <Icon className="jv-npc-kind"/>
      <span className="jv-npc-title">{step.title}</span>
      <span className="jv-npc-state">{step.state === "running" ? <LoaderCircleIcon/> : step.state === "ok" ? <CheckIcon/> : <XIcon/>}{t(`npc.state.${step.state}`)}</span>
      <span className="jv-npc-time">{seconds((step.endedAt ?? Date.now() + skew) - step.startedAt)}</span>
      {detail && <ChevronRightIcon className="jv-npc-chevron"/>}
    </button>
    {open && detail && <pre data-kind={step.icon}>{detail}</pre>}
  </li>;
}
