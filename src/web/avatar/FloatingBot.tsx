import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Bot, BotStatus } from "../../contract/bots";
import { BotAvatar } from "./BotAvatar";
import { MARKS, type FigureMotion } from "./motion";
import { BOT_COLORS } from "./palette";
import { FigureStage } from "./stage";
import { useActs } from "./useActs";
import { type BotColor, type BotMood } from "../../contract/models";
import { NpcLayer } from "./npc/NpcLayer";
import { NpcToolbar } from "./npc/NpcToolbar";
import { useNpcDemo } from "./npc/useNpcDemo";
import { useNpcLive } from "./npc/useNpcLive";
import { t } from "../i18n";
import "../styles/floating-bot.css";

const KEY = "jarvy-floating-bot", MARGIN = 10, DRAG = 4;
/** How far the canvas reaches past the cat's box on each side, as a share of the box: a hop or a lift raises the head
 * past the box's top, and the drawing must not be cut there. The figure is drawn smaller by as much, so at rest it is
 * the same size in the same place. */
const ROOM = .3, ZOOM = .86;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** With `?npc=demo` in the address the scripted demo turn drives the cat instead of the Bot's live turn (A47), with the
 * prototype toolbar. */
const NPC_DEMO = new URLSearchParams(location.search).get("npc") === "demo";
type Spot = { x: number; y: number };

/** What the marks beside the head look like; their colours come from the theme (floating-bot.css). */
const MARK = {
  zz: <><i>z</i><i>Z</i></>,
  ask: "?",
  sweat: <svg viewBox="0 0 20 28"><path d="M10 1C10 1 2 13 2 18.5a8 8 0 0 0 16 0C18 13 10 1 10 1Z"/><ellipse cx="7" cy="18" rx="1.8" ry="3"/></svg>,
  sparkle: <svg viewBox="0 0 100 100">{([[14, 22, 9], [86, 18, 7], [90, 46, 4.5]] as const).map(([x, y, r]) =>
    <path key={x} d={`M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`}/>)}</svg>,
};

/** The mark beside a live figure's head for what it is doing (asleep, struggling, asking, pleased), if any; it sits on
 * the figure's box, which must be a size container (floating-bot.css). */
export function FigureMark({ motion }: { motion: FigureMotion }) {
  const mark = MARKS[motion];
  return mark ? <span className="jv-figure-mark" data-mark={mark} aria-hidden="true">{MARK[mark]}</span> : null;
}

/** Bot status → body motion (A33). Mood is separate and only changes the face. */
export function motionOf(status?: BotStatus): { motion: FigureMotion; fast: boolean } {
  if (!status || status.status === "stop") return { motion: "sleep", fast: false };
  // Waiting for an answer looks like idle: the cat watches you.
  if (status.status !== "running" || status.activity === "asking") return { motion: "idle", fast: false };
  if (["compacting", "retrying", "aborting"].includes(status.phase)) return { motion: "busy", fast: false };
  if (status.activity === "tool_calling" || status.phase === "tool") return { motion: "work", fast: true };
  if (status.activity === "texting" || status.phase === "texting") return { motion: "work", fast: false };
  return { motion: "think", fast: false };
}
function savedSpot(): Spot {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "") as Spot;
    if (value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1) return value;
  } catch { /* first use: top right */ }
  return { x: 1, y: 0 };
}

/** The live Bot floating over its DM (replaces the title bar), acting out the turn it is running with a dialogue beside
 * it (A47) — the same model as every avatar, drawn every frame (A76). Drag to move — the spot is kept per browser as
 * fractions of the free area, so it survives resizes; it never leaves the chat area or covers the composer. Click opens
 * Bot info — or, once the last turn's line has faded, brings it back first. Eyes follow the pointer, or the composer
 * while typing. */
export function FloatingBot({ bot, chatId, status, area, avoid, lastMine, onOpen }: {
  bot: Bot; chatId: string; status?: BotStatus; area: RefObject<HTMLElement | null>; avoid: RefObject<HTMLElement | null>;
  /** The newest message you sent here: the cat listens for it (A86). */
  lastMine?: string; onOpen: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const spot = useRef<Spot>(savedSpot()), drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const moved = useRef(false), look = useRef<{ x: number; y: number } | null>(null);
  const [stage] = useState(() => new FigureStage()), input = stage.input, persona = stage.persona;
  const [rendering, setRendering] = useState(false);
  const layout = useRef<(() => void) | null>(null);
  const demo = useNpcDemo(NPC_DEMO, bot.mood as BotMood), turn = useNpcLive(NPC_DEMO ? null : bot.id, chatId, bot.mood as BotMood, motionOf(status));
  const npc = NPC_DEMO ? demo : turn;
  input.motion = npc.motion; input.fast = npc.fast; input.mood = npc.mood;

  function bounds() {
    const box = area.current!.getBoundingClientRect(), size = button.current!.offsetWidth;
    const bottom = avoid.current ? avoid.current.getBoundingClientRect().top - box.top : box.height;
    // Above the box is the room a lift or a hop rises into; the chat area cuts off what reaches past its top.
    const minY = Math.max(MARGIN, Math.round(ROOM * size));
    const maxX = Math.max(MARGIN, box.width - size - MARGIN), maxY = Math.max(minY, bottom - size - MARGIN);
    return { minX: MARGIN, minY, maxX, maxY };
  }
  /** Which way the cat turns, and so the side the dialogue comes out of: +1 to the right when it sits at the left of the
   * chat area, −1 to the left at the right, 0 straight at you in the middle. */
  function facing() {
    const box = area.current?.getBoundingClientRect(), el = button.current;
    if (!box || !el) return 0;
    const half = box.width / 2 - el.offsetWidth / 2;
    return half > 0 ? Math.max(-1, Math.min(1, (half - el.offsetLeft) / half)) : 0;
  }
  function place() {
    if (!button.current || !area.current) return;
    const b = bounds(), el = button.current;
    el.style.left = `${b.minX + spot.current.x * (b.maxX - b.minX)}px`; el.style.top = `${b.minY + spot.current.y * (b.maxY - b.minY)}px`;
    layout.current?.();
  }
  useLayoutEffect(() => {
    place();
    const observer = new ResizeObserver(place);
    for (const el of [area.current, avoid.current, button.current]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const failure = status?.error ? `${status.runId ?? ""}:${status.error}` : null;
  useEffect(() => { if (failure || npc.shake) stage.shake(); }, [failure, npc.shake]);

  useEffect(() => {
    const point = (event: PointerEvent) => { if (event.pointerType === "mouse" || event.type === "pointerdown") look.current = { x: event.clientX, y: event.clientY }; };
    const away = (event: PointerEvent) => { if (!event.relatedTarget) look.current = null; };
    const typing = (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.id !== "jarvy-composer") return;
      const box = target.getBoundingClientRect(); look.current = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    window.addEventListener("pointermove", point); window.addEventListener("pointerdown", point);
    document.addEventListener("pointerout", away); document.addEventListener("input", typing); document.addEventListener("focusin", typing);
    return () => {
      window.removeEventListener("pointermove", point); window.removeEventListener("pointerdown", point);
      document.removeEventListener("pointerout", away); document.removeEventListener("input", typing); document.removeEventListener("focusin", typing);
    };
  }, []);

  // The acts (A86) that answer what happens; touched, it is poked, and dragged, it is carried (below).
  useActs(persona, npc, chatId, lastMine);
  stage.color = (BOT_COLORS[bot.color as BotColor] ?? BOT_COLORS.gray).hex; stage.crown = bot.agent;
  useEffect(() => {
    if (!canvas.current) return;
    stage.onFrame = () => {
      const el = button.current;
      if (!el) return;
      const box = el.getBoundingClientRect(), target = look.current;
      input.lookX = target ? Math.max(-1, Math.min(1, (target.x - box.left - box.width / 2) / 320)) : 0;
      input.lookY = target ? Math.max(-1, Math.min(1, (target.y - box.top - box.height / 2) / 320)) : 0;
      // The figure turns towards the middle of the chat (the dialogue takes that side whenever it is placed). Not
      // working, it keeps its turn while it is carried, and asleep until it wakes; the first frame always takes it
      // from where the figure is.
      const carried = !!drag.current?.moved && input.motion === "idle";
      if (input.faceX === undefined || !(carried || input.motion === "sleep")) input.faceX = facing();
      // What it is doing, for the stylesheet and for tests: the act's name, while one plays.
      const act = persona.playing ?? "";
      if (el.dataset.act !== act) { if (act) el.dataset.act = act; else delete el.dataset.act; }
    };
    const remove = stage.add(canvas.current, ZOOM / (1 + 2 * ROOM));
    setRendering(stage.start());
    return () => { remove(); stage.stop(); stage.onFrame = null; };
    // The figure lives as long as the component; colour, mood and status flow in through the stage.
  }, []);

  return <><button ref={button} type="button" className="jv-floating-bot" data-live={rendering || undefined} data-motion={npc.motion} title={bot.name} aria-label={t("avatar.openInfo", { name: bot.name })}
    onPointerDown={event => {
      if (event.button !== 0) return;
      const el = event.currentTarget; el.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: el.offsetLeft, top: el.offsetTop, moved: false };
    }}
    onPointerMove={event => {
      const d = drag.current; if (!d || d.id !== event.pointerId) return;
      const dx = event.clientX - d.x, dy = event.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG) return;
      if (!d.moved && !reduced()) persona.carry(true, performance.now());
      d.moved = true;
      const b = bounds(), left = Math.min(b.maxX, Math.max(b.minX, d.left + dx)), top = Math.min(b.maxY, Math.max(b.minY, d.top + dy));
      spot.current = { x: b.maxX > b.minX ? (left - b.minX) / (b.maxX - b.minX) : 0, y: b.maxY > b.minY ? (top - b.minY) / (b.maxY - b.minY) : 0 };
      place();
    }}
    onPointerUp={event => {
      const d = drag.current; if (!d || d.id !== event.pointerId) return;
      drag.current = null; moved.current = d.moved;
      if (d.moved) { localStorage.setItem(KEY, JSON.stringify(spot.current)); if (!reduced()) persona.carry(false, performance.now()); }
    }}
    onPointerCancel={() => { drag.current = null; if (!reduced()) persona.carry(false, performance.now()); }}
    onClick={() => { if (moved.current) { moved.current = false; return; } if (!reduced()) persona.play("poke", performance.now()); if (npc.canRecap) npc.showRecap(); else onOpen(); }}
    style={{ "--jv-avatar-size": "100%" } as CSSProperties}>
    <canvas ref={canvas} aria-hidden="true" style={{ inset: `${-ROOM * 100}%`, width: `${(1 + 2 * ROOM) * 100}%`, height: `${(1 + 2 * ROOM) * 100}%` }}/>
    {/* Still (no WebGL, or none on a GPU: A88), it keeps its mood, its sleep and the mark of what it is doing. */}
    {!rendering && <BotAvatar color={bot.color} mood={npc.mood} size={88} crown={bot.agent} asleep={npc.motion === "sleep"}/>}
    <FigureMark motion={npc.motion}/>
  </button>
  <NpcLayer view={npc.view} name={bot.name} cat={button} area={area} avoid={avoid} layout={layout} facing={facing}
    toolbar={NPC_DEMO ? (bar, closePanel) => <NpcToolbar controls={demo.controls} toolbar={bar} onReplay={() => { closePanel(); demo.controls.replay(); }}/> : undefined}/></>;
}
