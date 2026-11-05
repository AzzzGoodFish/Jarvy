import { randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import sharp from "sharp";

/** The box a thumbnail fits in: twice the largest picture a message card shows (about 800 × 320 CSS pixels), for
 * high-density screens. */
const WIDTH = 1600, HEIGHT = 640;
/** A picture already inside the box and no larger than this is its own thumbnail. */
const SMALL = 300 * 1024;
/** Formats made smaller here; anything else (GIF, SVG, a format browsers don't show) is shown as it is. */
const FORMATS = new Set(["jpeg", "png", "webp", "avif"]);
/** Thumbnails made at once (each about 30–170 ms): a channel full of screenshots opens quickly without taking every core. */
const AT_ONCE = 4;

/** Pictures' thumbnails (A80): made the first time one is asked for, from the original, and kept beside it as WebP
 * (`<id>.thumb`), never enlarged and the right way up. An animated picture, one already small, or one that can't be
 * read has none: its original is shown. */
export class Thumbnails {
  private readonly making = new Map<string, Promise<string | null>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  /** The thumbnail's path for the original at `source`, kept at `target`; null to show the original. */
  async thumbnail(source: string, target: string): Promise<string | null> {
    if (await stat(target).then(() => true, () => false)) return target;
    let pending = this.making.get(target);
    if (!pending) {
      pending = this.make(source, target).finally(() => this.making.delete(target));
      this.making.set(target, pending);
    }
    return pending;
  }

  private async make(source: string, target: string): Promise<string | null> {
    const meta = await sharp(source).metadata().catch(() => null);
    if (!meta?.width || !meta.height || !FORMATS.has(meta.format ?? "") || (meta.pages ?? 1) > 1) return null;
    // EXIF orientations 5–8 turn the picture a quarter: its width on screen is its stored height.
    const [width, height] = (meta.orientation ?? 1) >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
    if (width <= WIDTH && height <= HEIGHT && (meta.size ?? (await stat(source)).size) <= SMALL) return null;
    await this.turn();
    const part = `${target}.${randomUUID()}.part`;
    try {
      await sharp(source).rotate().resize(WIDTH, HEIGHT, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toFile(part);
      await rename(part, target);
      return target;
    } catch (error) {
      console.warn("[files] could not make a thumbnail", { source, error: error instanceof Error ? error.message : String(error) });
      await rm(part, { force: true });
      return null;
    } finally { this.done(); }
  }
  private async turn() {
    if (this.running < AT_ONCE) { this.running++; return; }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }
  private done() {
    const next = this.waiting.shift();
    if (next) next(); else this.running--;
  }
}
