import { crownAt, makeFigure, type Figure } from "./face";
import { Rig, type FigureInput } from "./motion";
import { Persona } from "./acts";
import { crownMark } from "./snapshot";

/** Below this width (CSS pixels) a figure is small: the rail's cat. */
const SMALL = 64;
/** How often a small figure on its own is drawn (ms): at rest, and while it works, acts, has the pointer on it or
 * settles after an act. At its size the breathing reads the same at five frames a second and an act at thirty, and a
 * machine that draws WebGL without a GPU, where each frame keeps several cores busy for a moment, is spared most of it. A
 * larger figure on screen is drawn every frame. */
const RESTING = 200, LIVELY = 33, SETTLING = 800;
/** A WebGL figure, or null where one can't be made (no WebGL, or the shader did not build). */
function make(): Figure | null { try { return makeFigure() ?? null; } catch { return null; } }

/** A live figure (A76) drawn every frame: one `Rig` for its motion and one `Persona` for its acts (A86), painted on every
 * canvas added to it. The rail's small cat and the home page's large one are one stage, so they are the same cat at the
 * same moment rather than two that disagree. Each canvas has a WebGL figure of its own, at its own size: one figure
 * painting both sizes would resize its drawing buffer twice a frame, which without a GPU takes a whole core. Drawing
 * pauses while the page is hidden and while none of its canvases is on screen; where the figure can't be drawn (no
 * WebGL) it never starts, and the caller keeps its still avatar. */
export class FigureStage {
  readonly persona = new Persona();
  readonly input: FigureInput = { motion: "sleep", mood: "normal", lookX: 0, lookY: 0 };
  color = 0; crown = false;
  /** The pointer is on a small figure: it is drawn at the lively rate, so its eyes follow smoothly. */
  near = false;
  /** Runs at the start of each frame, before the face is worked out: to aim the eyes or turn the head. */
  onFrame: ((now: number) => void) | null = null;
  private readonly rig = new Rig();
  private readonly canvases = new Map<HTMLCanvasElement, { zoom: number; shadow: boolean; figure: Figure | null }>();
  private readonly reduced = matchMedia("(prefers-reduced-motion: reduce)");
  /** The figure made by `start` to see whether one can be drawn, given to the first canvas that needs one. */
  private spare: Figure | null = null;
  private running = false; private frame = 0; private last = 0; private drawn = 0; private stirred = 0;

  shake() { this.rig.shake(); }
  /** Draws on `canvas` too, at `zoom` (a little under 1, so a stretch or a lift never touches the edge), until the
   * returned function is called. */
  add(canvas: HTMLCanvasElement, zoom: number, shadow = true): () => void {
    this.canvases.set(canvas, { zoom, shadow, figure: null });
    return () => { this.canvases.get(canvas)?.figure?.dispose(); this.canvases.delete(canvas); };
  }
  /** The largest of its canvases on screen, or null: where the eyes look from. */
  largest(): HTMLCanvasElement | null {
    let best: HTMLCanvasElement | null = null;
    for (const canvas of this.canvases.keys()) if (canvas.offsetWidth > (best?.offsetWidth ?? 0)) best = canvas;
    return best;
  }
  /** Starts drawing; false where the figure can't be drawn. */
  start(): boolean {
    if (this.running) return true;
    this.spare = make();
    if (!this.spare) return false;
    this.running = true;
    document.addEventListener("visibilitychange", this.visibility); this.visibility();
    return true;
  }
  stop() {
    document.removeEventListener("visibilitychange", this.visibility); cancelAnimationFrame(this.frame);
    this.running = false; this.spare?.dispose(); this.spare = null;
    for (const entry of this.canvases.values()) { entry.figure?.dispose(); entry.figure = null; }
  }
  private readonly visibility = () => { cancelAnimationFrame(this.frame); if (!document.hidden) this.frame = requestAnimationFrame(this.tick); };
  private readonly tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    const shown = [...this.canvases].filter(([canvas]) => canvas.offsetWidth > 0);
    if (!this.running || !shown.length) { this.last = 0; return; }
    const input = this.input, busy = input.motion !== "idle" && input.motion !== "sleep";
    const small = shown.every(([canvas]) => canvas.offsetWidth < SMALL);
    if (small) {
      if (this.near || this.persona.playing || busy) this.stirred = now;
      // A little early, as frames do not land exactly on the interval.
      if (now - this.drawn < (now - this.stirred < SETTLING ? LIVELY : RESTING) - 4) return;
    }
    this.drawn = now;
    this.onFrame?.(now);
    input.reduced = this.reduced.matches;
    const base = this.rig.frame(now, input);
    // An idle act now and then, only at rest and only with a large figure on screen: the rail's cat beside a chat
    // keeps still, but for the acts that answer what happens. Asleep counts as rest, so a sleeping cat still flicks an ear.
    if (!input.reduced && !small) this.persona.idle(now, this.last ? Math.min(50, now - this.last) : 16, busy, input.motion === "sleep");
    this.last = now;
    const { face, zoom: swell } = this.persona.apply(base, now);
    for (const [canvas, entry] of shown) {
      const paint = canvas.getContext("2d"), pixels = Math.round(canvas.offsetWidth * Math.min(2, devicePixelRatio || 1)), zoom = entry.zoom * swell;
      if (!paint) continue;
      if (!entry.figure) { entry.figure = this.spare ?? make(); this.spare = null; }
      if (!entry.figure) continue;
      if (canvas.width !== pixels) canvas.width = canvas.height = pixels; else paint.clearRect(0, 0, pixels, pixels);
      entry.figure.paint(paint, pixels, this.color, face, { zoom, shadow: entry.shadow });
      // The crown turns with the head: side on, it is edge-on and unseen.
      if (this.crown) { paint.globalAlpha = Math.min(1, Math.max(0, Math.cos(face.spin) * 1.6 - .2)); crownMark(paint, pixels, crownAt(face, zoom)); paint.globalAlpha = 1; }
    }
  };
}
