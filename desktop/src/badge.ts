import { nativeImage, type NativeImage } from "electron";
import { deflateSync } from "node:zlib";

/** The taskbar's count (A96): a red disc with white digits, drawn here because Windows takes an overlay image, not a
 * number. A 5×7 bitmap font, scaled, is all it needs; "99+" past 99, as the page's own badges. */
const FONT: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
};
const SIZE = 32;

export function badge(count: number): NativeImage | null {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const set = (x: number, y: number, rgba: readonly number[]) => { if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) pixels.set(rgba, (y * SIZE + x) * 4); };
  // The disc, with a soft edge.
  const r = SIZE / 2;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x + 0.5 - r, y + 0.5 - r), a = Math.max(0, Math.min(1, r - d));
    if (a > 0) set(x, y, [0xe5, 0x48, 0x4d, Math.round(a * 255)]);
  }
  // The digits, as large as fit.
  const scale = label.length === 1 ? 3 : label.length === 2 ? 2 : 1, gap = scale;
  const width = label.length * 5 * scale + (label.length - 1) * gap, left = Math.round((SIZE - width) / 2), top = Math.round((SIZE - 7 * scale) / 2);
  [...label].forEach((char, i) => {
    const rows = FONT[char]!;
    rows.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit !== "1") return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++)
        set(left + i * (5 * scale + gap) + x * scale + dx, top + y * scale + dy, [255, 255, 255, 255]);
    }));
  });
  return nativeImage.createFromBuffer(png(pixels));
}

/** A truecolour-with-alpha PNG of the pixels. */
function png(rgba: Buffer): Buffer {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(data: Buffer): number { let c = 0xffffffff; for (const byte of data) c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
