import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Bot, BotStatus } from "../../contract/bots";
import { BotAvatar } from "./BotAvatar";
import { crownAt, makeFigure, type Figure } from "./face";
import { MARKS, Rig, type FigureInput, type FigureMotion } from "./motion";
import { Persona } from "./acts";
import { BOT_COLORS } from "./palette";
import { crownMark } from "./snapshot";
import { type BotColor, type BotMood } from "../../contract/models";
import { NpcLayer } from "./npc/NpcLayer";
import { NpcToolbar } from "./npc/NpcToolbar";
import { useNpcDemo } from "./npc/useNpcDemo";
import { useNpcLive } from "./npc/useNpcLive";
import { t } from "../i18n";
import "../styles/floating-bot.css";

const KEY = "jarvy-floating-bot", MARGIN = 10, DRAG = 4;
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
  const input = useRef<FigureInput>({ motion: "sleep", mood: "normal", lookX: 0, lookY: 0 });
  const figure = useRef<{ shake(): void } | null>(null), persona = useRef(new Persona()), busy = useRef(false);
  const [rendering, setRendering] = useState(false);
  const layout = useRef<(() => void) | null>(null);
  const demo = useNpcDemo(NPC_DEMO, bot.mood as BotMood), turn = useNpcLive(NPC_DEMO ? null : bot.id, chatId, bot.mood as BotMood, motionOf(status));
  const npc = NPC_DEMO ? demo : turn;
  input.current.motion = npc.motion; input.current.fast = npc.fast; input.current.mood = npc.mood;
  const mark = MARKS[npc.motion];

  function bounds() {
    const box = area.current!.getBoundingClientRect(), size = button.current!.offsetWidth;
    const bottom = avoid.current ? avoid.current.getBoundingClientRect().top - box.top : box.height;
    const maxX = Math.max(MARGIN, box.width - size - MARGIN), maxY = Math.max(MARGIN, bottom - size - MARGIN);
    return { minX: MARGIN, minY: MARGIN, maxX, maxY };
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
  useEffect(() => { if (failure || npc.shake) figure.current?.shake(); }, [failure, npc.shake]);

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

  // The acts (A86): you send a message, it listens; it starts working, it hops; a turn completes, it celebrates;
  // touched, it is poked; dragged, it is carried. Nothing at all with reduced motion.
  const heard = useRef<{ chat: string; id?: string } | null>(null);
  useEffect(() => {
    const before = heard.current;
    heard.current = { chat: chatId, id: lastMine };
    // The first message here, and the chat you just opened, are not something to listen to.
    if (!before || before.chat !== chatId || !lastMine || lastMine === before.id) return;
    if (!reduced()) persona.current.play("listen", performance.now());
  }, [lastMine, chatId]);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rest = npc.motion === "idle" || npc.motion === "sleep";
    if (rest) { busy.current = false; return; }
    // A turn under way after a rest: the wind-up before it works.
    if (!busy.current) { busy.current = true; persona.current.play("hop", performance.now(), true); }
  }, [npc.motion]);
  const finished = useRef<number | null>(null);
  useEffect(() => {
    const done = npc.view.done;
    if (!done || finished.current === npc.view.startedAt) return;
    finished.current = npc.view.startedAt;
    if (done.outcome !== "completed" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const pick = ["joy", "hopSpin", "dance"][Math.floor(Math.random() * 3)] as "joy" | "hopSpin" | "dance";
    persona.current.play(pick, performance.now());
  }, [npc.view.done, npc.view.startedAt]);
  const color = useRef((BOT_COLORS[bot.color as BotColor] ?? BOT_COLORS.gray).hex), crown = useRef(bot.agent);
  useEffect(() => { color.current = (BOT_COLORS[bot.color as BotColor] ?? BOT_COLORS.gray).hex; }, [bot.color]);
  useEffect(() => { crown.current = bot.agent; }, [bot.agent]);
  useEffect(() => {
    const out = canvas.current, paint = out?.getContext("2d");
    let drawn: Figure | undefined;
    try { drawn = makeFigure(); } catch { /* the shader did not build: the still avatar stays */ }
    if (!out || !paint || !drawn) return; // no WebGL: the still avatar stays
    const live = drawn, rig = new Rig(), reduced = matchMedia("(prefers-reduced-motion: reduce)"), last = { current: 0 };
    let frame = 0;
    figure.current = { shake: () => rig.shake() };
    const tick = (now: number) => {
      const el = button.current;
      if (el?.offsetWidth) {
        const pixels = Math.round(el.offsetWidth * Math.min(2, devicePixelRatio || 1));
        const box = el.getBoundingClientRect(), target = look.current;
        input.current.lookX = target ? Math.max(-1, Math.min(1, (target.x - box.left - box.width / 2) / 320)) : 0;
        input.current.lookY = target ? Math.max(-1, Math.min(1, (target.y - box.top - box.height / 2) / 320)) : 0;
        input.current.reduced = reduced.matches;
        // The figure turns towards the middle of the chat (the dialogue takes that side whenever it is placed). Not
        // working, it keeps its turn while it is carried, and asleep until it wakes; the first frame always takes it
        // from where the figure is.
        const motion = input.current.motion, carried = !!drag.current?.moved && motion === "idle";
        if (input.current.faceX === undefined || !(carried || motion === "sleep")) input.current.faceX = facing();
        // A little smaller than a still avatar, so a stretch or a lift never touches the edge.
        const base = rig.frame(now, input.current), being = persona.current;
        // An idle act now and then, only while the cat is at rest and the page is being looked at.
        if (!input.current.reduced) being.idle(now, last.current ? Math.min(50, now - last.current) : 16, input.current.motion !== "idle", input.current.motion === "sleep");
        last.current = now;
        const { face, zoom: swell } = being.apply(base, now), zoom = .86 * swell;
        // What it is doing, for the stylesheet and for tests: the act's name, while one plays.
        const act = being.playing ?? "";
        if (el.dataset.act !== act) { if (act) el.dataset.act = act; else delete el.dataset.act; }
        if (out.width !== pixels) out.width = out.height = pixels; else paint.clearRect(0, 0, pixels, pixels);
        live.paint(paint, pixels, color.current, face, { zoom });
        // The crown turns with the head: side on, it is edge-on and unseen.
        if (crown.current) { paint.globalAlpha = Math.max(0, Math.cos(face.spin) * 1.6 - .2); crownMark(paint, pixels, crownAt(face, zoom)); paint.globalAlpha = 1; }
      }
      frame = requestAnimationFrame(tick);
    };
    // Rendering pauses while the page is hidden.
    const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden) frame = requestAnimationFrame(tick); };
    document.addEventListener("visibilitychange", visibility); visibility(); setRendering(true);
    return () => { document.removeEventListener("visibilitychange", visibility); cancelAnimationFrame(frame); figure.current = null; live.dispose(); };
    // The figure lives as long as the component; colour, mood and status flow in through refs.
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
      if (!d.moved && !reduced()) persona.current.carry(true, performance.now());
      d.moved = true;
      const b = bounds(), left = Math.min(b.maxX, Math.max(b.minX, d.left + dx)), top = Math.min(b.maxY, Math.max(b.minY, d.top + dy));
      spot.current = { x: b.maxX > b.minX ? (left - b.minX) / (b.maxX - b.minX) : 0, y: b.maxY > b.minY ? (top - b.minY) / (b.maxY - b.minY) : 0 };
      place();
    }}
    onPointerUp={event => {
      const d = drag.current; if (!d || d.id !== event.pointerId) return;
      drag.current = null; moved.current = d.moved;
      if (d.moved) { localStorage.setItem(KEY, JSON.stringify(spot.current)); if (!reduced()) persona.current.carry(false, performance.now()); }
    }}
    onPointerCancel={() => { drag.current = null; }}
    onClick={() => { if (moved.current) { moved.current = false; return; } if (!reduced()) persona.current.play("poke", performance.now()); if (npc.canRecap) npc.showRecap(); else onOpen(); }}
    style={{ "--jv-avatar-size": "100%" } as CSSProperties}>
    <canvas ref={canvas} aria-hidden="true"/>
    {!rendering && <BotAvatar color={bot.color} mood={bot.mood} size={88} crown={bot.agent}/>}
    {rendering && mark && <span className="jv-figure-mark" data-mark={mark} aria-hidden="true">{MARK[mark]}</span>}
  </button>
  <NpcLayer view={npc.view} name={bot.name} cat={button} area={area} avoid={avoid} layout={layout} facing={facing}
    toolbar={NPC_DEMO ? (bar, closePanel) => <NpcToolbar controls={demo.controls} toolbar={bar} onReplay={() => { closePanel(); demo.controls.replay(); }}/> : undefined}/></>;
}
