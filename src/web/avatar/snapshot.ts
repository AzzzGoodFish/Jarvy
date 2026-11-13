import { BOT_COLORS } from "./palette";
import { faceOf } from "./pose";
import { crownAt, makeFigure, type Figure } from "./face";
import { ASLEEP } from "./motion";
import { type BotColor, type BotMood } from "../../contract/models";

/** From this size (CSS pixels) an avatar is large — Bot info, the DM figure — and gets a ground shadow and the agent's
 * crown; below it both would only smudge the silhouette. */
const LARGE = 40;
/** A small avatar has no shadow under it, so the figure, framed with room for one, sits high in its box: this much
 * lower (a share of the box) centres the ears-to-feet height, so it lines up with a person's round avatar beside it. */
const LOWER = .05;
const cache = new Map<string, Promise<string>>();
let still: { figure: Figure; out: HTMLCanvasElement } | null | undefined;

/** The agent Bot's crown (A48), drawn flat on the head: a gold band with three points and a pearl on each. */
export function crownMark(g: CanvasRenderingContext2D, pixels: number, at: ReturnType<typeof crownAt>) {
  const k = pixels / 100;
  g.save(); g.translate(at.x * pixels, at.y * pixels); g.rotate(at.angle); g.scale(at.scale, at.scale);
  g.fillStyle = "#f2b830"; g.strokeStyle = "#c98d12"; g.lineWidth = 1.6 * k; g.lineJoin = "round";
  g.beginPath(); g.moveTo(-13 * k, 6 * k); g.lineTo(-13 * k, -2 * k); g.lineTo(-6 * k, 3 * k); g.lineTo(0, -7 * k);
  g.lineTo(6 * k, 3 * k); g.lineTo(13 * k, -2 * k); g.lineTo(13 * k, 6 * k); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = "#fff6dc";
  for (const [x, y] of [[-13, -2], [0, -7], [13, -2]] as const) { g.beginPath(); g.arc(x * k, y * k, 2.2 * k, 0, Math.PI * 2); g.fill(); }
  g.restore();
}

/** One offscreen WebGL figure turns the model into still images, so any number of avatars, at any size and in any mood,
 * costs a single WebGL context (A76). */
function render(color: BotColor, mood: BotMood, pixels: number, large: boolean, crown: boolean, asleep: boolean): string {
  if (still === undefined) { const figure = makeFigure(); still = figure ? { figure, out: document.createElement("canvas") } : null; }
  if (!still) return "";
  const { figure, out } = still;
  const face = asleep ? { ...faceOf(mood), ...ASLEEP } : faceOf(mood), zoom = large ? .92 : .9;
  out.width = out.height = pixels;
  const g = out.getContext("2d"); if (!g) return "";
  if (!large) g.translate(0, LOWER * pixels);
  figure.paint(g, pixels, BOT_COLORS[color]?.hex ?? BOT_COLORS.gray.hex, face, { shadow: large, zoom });
  if (crown) crownMark(g, pixels, crownAt(face, zoom));
  return out.toDataURL("image/png");
}

/** PNG data URL of the figure, crowned for the agent Bot when large, asleep when it stands in for a sleeping live figure;
 * size is CSS pixels, rendered at the device pixel ratio. */
export function snapshot(color: BotColor, mood: BotMood, size: number, density: number, crown = false, asleep = false): Promise<string> {
  const pixels = Math.round(size * Math.min(3, Math.max(1, density)));
  const large = size >= LARGE, crowned = crown && large;
  const key = `${color}:${mood}:${pixels}:${crowned}:${asleep}`;
  let image = cache.get(key);
  if (!image) {
    image = Promise.resolve().then(() => render(color, mood, pixels, large, crowned, asleep));
    cache.set(key, image);
    image.catch(() => cache.delete(key));
  }
  return image;
}
