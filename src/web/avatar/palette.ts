import type { Key } from "../i18n";
import type { BotColor } from "../../contract/models";

/** How each Bot colour (the contract's `BotColor`) looks on the figure: saturated, because a flat disc of a pastel reads
 * as a wash. `label` is a key. */
export const BOT_COLORS = {
  gray: { hex: 0x8b8f99, label: "color.gray" },
  blue: { hex: 0x1e86fc, label: "color.blue" },
  green: { hex: 0x2fbf6b, label: "color.green" },
  amber: { hex: 0xf59312, label: "color.amber" },
  rose: { hex: 0xf2537f, label: "color.rose" },
  violet: { hex: 0x8a5cf6, label: "color.violet" },
} as const satisfies Record<BotColor, { hex: number; label: Key }>;
export const colorHex = (color: string) => `#${(BOT_COLORS[color as BotColor]?.hex ?? BOT_COLORS.gray.hex).toString(16).padStart(6, "0")}`;
