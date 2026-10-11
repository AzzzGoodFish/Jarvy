import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Bot, BotStatus } from "../api";
import { BotAvatar } from "./BotAvatar";
import type { FigureInput, FigureMotion } from "./figure";
import { BOT_COLORS, type BotColor, type BotMood } from "./palette";
import "../styles/floating-bot.css";

const KEY = "jarvy-floating-bot", MARGIN = 10, DRAG = 4;
type Spot = { x: number; y: number };

/** Bot status → body motion (A33). Mood is separate and only changes the eyes. */
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

/** The live 3D Bot floating over the chat (replaces the title bar). Drag to move — the spot is kept
 * per browser as fractions of the free area, so it survives resizes; it never leaves the chat area
 * or covers the composer. Click opens Bot info. Eyes follow the pointer, or the composer while typing. */
export function FloatingBot({ bot, status, area, avoid, onOpen }: {
  bot: Bot; status?: BotStatus; area: RefObject<HTMLElement | null>; avoid: RefObject<HTMLElement | null>; onOpen: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const spot = useRef<Spot>(savedSpot()), drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const moved = useRef(false), look = useRef<{ x: number; y: number } | null>(null);
  const input = useRef<FigureInput>({ motion: "sleep", mood: "normal", lookX: 0, lookY: 0 });
  const figure = useRef<{ setColor(hex: number): void; shake(now: number): void } | null>(null);
  const [live, setLive] = useState(false);
  const { motion, fast } = motionOf(status);
  input.current.motion = motion; input.current.fast = fast; input.current.mood = bot.mood as BotMood;

  function bounds() {
    const box = area.current!.getBoundingClientRect(), size = button.current!.offsetWidth;
    const bottom = avoid.current ? avoid.current.getBoundingClientRect().top - box.top : box.height;
    const maxX = Math.max(MARGIN, box.width - size - MARGIN), maxY = Math.max(MARGIN, bottom - size - MARGIN);
    return { minX: MARGIN, minY: MARGIN, maxX, maxY };
  }
  function place() {
    if (!button.current || !area.current) return;
    const b = bounds(), el = button.current;
    el.style.left = `${b.minX + spot.current.x * (b.maxX - b.minX)}px`; el.style.top = `${b.minY + spot.current.y * (b.maxY - b.minY)}px`;
  }
  useLayoutEffect(() => {
    place();
    const observer = new ResizeObserver(place);
    for (const el of [area.current, avoid.current, button.current]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { figure.current?.setColor((BOT_COLORS[bot.color as BotColor] ?? BOT_COLORS.gray).hex); }, [bot.color]);
  const failure = status?.error ? `${status.runId ?? ""}:${status.error}` : null;
  useEffect(() => { if (failure) figure.current?.shake(performance.now()); }, [failure]);

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

  useEffect(() => {
    let alive = true, frame = 0, stop = () => {};
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    void Promise.all([import("three"), import("./figure")]).then(([THREE, shape]) => {
      if (!alive || !canvas.current) return;
      const renderer = new THREE.WebGLRenderer({ canvas: canvas.current, antialias: true, alpha: true });
      shape.configureRenderer(THREE, renderer);
      const { scene, camera } = shape.createStage(THREE);
      const cat = new shape.CatFigure(THREE, (BOT_COLORS[bot.color as BotColor] ?? BOT_COLORS.gray).hex);
      cat.pose(input.current.mood); scene.add(cat.root); shape.frameCamera(camera, 1, 3.3);
      figure.current = cat;
      let pixels = 0;
      const tick = (now: number) => {
        const el = button.current;
        if (el) {
          const size = Math.round(el.offsetWidth * Math.min(2, devicePixelRatio || 1));
          if (size !== pixels) { pixels = size; renderer.setSize(size, size, false); }
          const box = el.getBoundingClientRect(), target = look.current;
          input.current.lookX = target ? Math.max(-1, Math.min(1, (target.x - box.left - box.width / 2) / 320)) : 0;
          input.current.lookY = target ? Math.max(-1, Math.min(1, (target.y - box.top - box.height / 2) / 320)) : 0;
          input.current.reduced = reduced.matches;
          cat.frame(now, input.current); renderer.render(scene, camera);
        }
        frame = requestAnimationFrame(tick);
      };
      // Rendering pauses while the page is hidden.
      const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden) frame = requestAnimationFrame(tick); };
      document.addEventListener("visibilitychange", visibility); visibility(); setLive(true);
      stop = () => {
        document.removeEventListener("visibilitychange", visibility); cancelAnimationFrame(frame);
        cat.dispose(); renderer.dispose(); renderer.forceContextLoss(); figure.current = null;
      };
    }).catch(() => { /* no WebGL: the still avatar stays */ });
    return () => { alive = false; stop(); };
    // The renderer lives as long as the component; colour, mood and status flow in through refs.
  }, []);

  return <button ref={button} type="button" className="jv-floating-bot" data-live={live || undefined} title={bot.name} aria-label={`查看 ${bot.name} 的 Bot 信息`}
    onPointerDown={event => {
      if (event.button !== 0) return;
      const el = event.currentTarget; el.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: el.offsetLeft, top: el.offsetTop, moved: false };
    }}
    onPointerMove={event => {
      const d = drag.current; if (!d || d.id !== event.pointerId) return;
      const dx = event.clientX - d.x, dy = event.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < DRAG) return;
      d.moved = true;
      const b = bounds(), left = Math.min(b.maxX, Math.max(b.minX, d.left + dx)), top = Math.min(b.maxY, Math.max(b.minY, d.top + dy));
      spot.current = { x: b.maxX > b.minX ? (left - b.minX) / (b.maxX - b.minX) : 0, y: b.maxY > b.minY ? (top - b.minY) / (b.maxY - b.minY) : 0 };
      place();
    }}
    onPointerUp={event => {
      const d = drag.current; if (!d || d.id !== event.pointerId) return;
      drag.current = null; moved.current = d.moved;
      if (d.moved) localStorage.setItem(KEY, JSON.stringify(spot.current));
    }}
    onPointerCancel={() => { drag.current = null; }}
    onClick={() => { if (moved.current) { moved.current = false; return; } onOpen(); }}
    style={{ "--jv-avatar-size": "100%" } as CSSProperties}>
    <canvas ref={canvas} aria-hidden="true"/>
    {!live && <BotAvatar color={bot.color} mood={bot.mood} size={88}/>}
  </button>;
}
