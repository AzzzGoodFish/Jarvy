import { BOT_COLORS } from "./palette";
import { type BotColor, type BotMood } from "../../contract/models";

type Renderer = { render(color: BotColor, mood: BotMood, pixels: number, shadow: boolean, crown: boolean): string };
let renderer: Promise<Renderer> | undefined;
const cache = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();

/** One shared offscreen WebGL renderer turns the figure into still images, so any number of small
 * avatars costs a single WebGL context. three.js loads on first use. */
function load(): Promise<Renderer> {
  renderer ??= Promise.all([import("three"), import("./figure")]).then(([THREE, figure]) => {
    const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    figure.configureRenderer(THREE, webgl);
    const { scene, camera, ground } = figure.createStage(THREE);
    const cat = new figure.CatFigure(THREE, BOT_COLORS.gray.hex); scene.add(cat.root);
    figure.frameCamera(camera, 1, 3.3);
    return {
      render(color, mood, pixels, shadow, crown) {
        webgl.setSize(pixels, pixels, false);
        cat.setColor(BOT_COLORS[color]?.hex ?? BOT_COLORS.gray.hex); cat.setCrown(crown); cat.pose(mood); ground.visible = shadow;
        webgl.render(scene, camera);
        return webgl.domElement.toDataURL("image/png");
      },
    };
  });
  return renderer;
}
/** PNG data URL of the figure, crowned for the agent Bot; size is CSS pixels, rendered at the device pixel ratio. */
export function snapshot(color: BotColor, mood: BotMood, size: number, crown = false): Promise<string> {
  const pixels = Math.round(size * Math.min(3, Math.max(1, window.devicePixelRatio || 1)));
  const key = `${color}:${mood}:${pixels}:${crown}`;
  let image = cache.get(key);
  if (!image) {
    // Renders share one canvas, so they run one at a time.
    image = queue.then(() => load()).then(r => r.render(color, mood, pixels, size >= 40, crown));
    queue = image.catch(() => {});
    cache.set(key, image);
    image.catch(() => cache.delete(key));
  }
  return image;
}
