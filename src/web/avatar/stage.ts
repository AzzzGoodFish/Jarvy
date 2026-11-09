import { crownAt, makeFigure, type Figure } from "./face";
import { Rig, type FigureInput } from "./motion";
import { Persona } from "./acts";
import { crownMark } from "./snapshot";

/** A live figure (A76) drawn every frame: one `Rig` for its motion and one `Persona` for its acts (A86), painted on every
 * canvas added to it at that canvas's own size. The rail's small cat and the home page's large one are one stage, so
 * they are the same cat at the same moment rather than two that disagree. Drawing pauses while the page is hidden and
 * while none of its canvases is on screen; where the figure can't be drawn (no WebGL) it never starts, and the caller
 * keeps its still avatar. */
export class FigureStage {
  readonly persona = new Persona();
  readonly input: FigureInput = { motion: "sleep", mood: "normal", lookX: 0, lookY: 0 };
  color = 0; crown = false;
  /** Runs at the start of each frame, before the face is worked out: to aim the eyes or turn the head. */
  onFrame: ((now: number) => void) | null = null;
  private readonly rig = new Rig();
  private readonly canvases = new Map<HTMLCanvasElement, { zoom: number; shadow: boolean }>();
  private readonly reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private figure: Figure | null = null; private frame = 0; private last = 0;

  shake() { this.rig.shake(); }
  /** Draws on `canvas` too, at `zoom` (a little under 1, so a stretch or a lift never touches the edge), until the
   * returned function is called. */
  add(canvas: HTMLCanvasElement, zoom: number, shadow = true): () => void {
    this.canvases.set(canvas, { zoom, shadow });
    return () => { this.canvases.delete(canvas); };
  }
  /** The largest of its canvases on screen, or null: where the eyes look from. */
  largest(): HTMLCanvasElement | null {
    let best: HTMLCanvasElement | null = null;
    for (const canvas of this.canvases.keys()) if (canvas.offsetWidth > (best?.offsetWidth ?? 0)) best = canvas;
    return best;
  }
  /** Starts drawing; false where the figure can't be drawn. */
  start(): boolean {
    if (this.figure) return true;
    try { this.figure = makeFigure() ?? null; } catch { this.figure = null; /* the shader did not build */ }
    if (!this.figure) return false;
    document.addEventListener("visibilitychange", this.visibility); this.visibility();
    return true;
  }
  stop() {
    document.removeEventListener("visibilitychange", this.visibility); cancelAnimationFrame(this.frame);
    this.figure?.dispose(); this.figure = null;
  }
  private readonly visibility = () => { cancelAnimationFrame(this.frame); if (!document.hidden) this.frame = requestAnimationFrame(this.tick); };
  private readonly tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    const figure = this.figure, shown = [...this.canvases].filter(([canvas]) => canvas.offsetWidth > 0);
    if (!figure || !shown.length) { this.last = 0; return; }
    this.onFrame?.(now);
    const input = this.input;
    input.reduced = this.reduced.matches;
    const base = this.rig.frame(now, input);
    // An idle act now and then, only at rest. Asleep counts as rest, so a sleeping cat still flicks an ear.
    const busy = input.motion !== "idle" && input.motion !== "sleep";
    if (!input.reduced) this.persona.idle(now, this.last ? Math.min(50, now - this.last) : 16, busy, input.motion === "sleep");
    this.last = now;
    const { face, zoom: swell } = this.persona.apply(base, now);
    for (const [canvas, { zoom: size, shadow }] of shown) {
      const paint = canvas.getContext("2d"), pixels = Math.round(canvas.offsetWidth * Math.min(2, devicePixelRatio || 1)), zoom = size * swell;
      if (!paint) continue;
      if (canvas.width !== pixels) canvas.width = canvas.height = pixels; else paint.clearRect(0, 0, pixels, pixels);
      figure.paint(paint, pixels, this.color, face, { zoom, shadow });
      // The crown turns with the head: side on, it is edge-on and unseen.
      if (this.crown) { paint.globalAlpha = Math.min(1, Math.max(0, Math.cos(face.spin) * 1.6 - .2)); crownMark(paint, pixels, crownAt(face, zoom)); paint.globalAlpha = 1; }
    }
  };
}
