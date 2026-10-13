import type { Key } from "../i18n";

/** Bot figure colours and moods. Names match the server's Bot.color / Bot.mood values; `label` is a key. */
export const BOT_COLORS = {
  gray: { hex: 0xd6d4cb, label: "color.gray" },
  blue: { hex: 0x9fc3e8, label: "color.blue" },
  green: { hex: 0xa8d5ae, label: "color.green" },
  amber: { hex: 0xf0c27a, label: "color.amber" },
  rose: { hex: 0xeeb0c4, label: "color.rose" },
  violet: { hex: 0xc2b0ea, label: "color.violet" },
} as const satisfies Record<string, { hex: number; label: Key }>;
export type BotColor = keyof typeof BOT_COLORS;
export const BOT_MOODS = ["normal", "happy", "sad", "angry", "dizzy"] as const;
export type BotMood = typeof BOT_MOODS[number];
export const colorHex = (color: string) => `#${(BOT_COLORS[color as BotColor]?.hex ?? BOT_COLORS.gray.hex).toString(16).padStart(6, "0")}`;
