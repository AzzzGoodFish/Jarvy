/** Bot figure colours and moods. Names match the server's Bot.color / Bot.mood values. */
export const BOT_COLORS = {
  gray: { hex: 0xd6d4cb, label: "灰" },
  blue: { hex: 0x9fc3e8, label: "蓝" },
  green: { hex: 0xa8d5ae, label: "绿" },
  amber: { hex: 0xf0c27a, label: "琥珀" },
  rose: { hex: 0xeeb0c4, label: "粉" },
  violet: { hex: 0xc2b0ea, label: "紫" },
} as const;
export type BotColor = keyof typeof BOT_COLORS;
export const BOT_MOODS = ["normal", "happy", "sad", "angry", "dizzy"] as const;
export type BotMood = typeof BOT_MOODS[number];
export const colorHex = (color: string) => `#${(BOT_COLORS[color as BotColor]?.hex ?? BOT_COLORS.gray.hex).toString(16).padStart(6, "0")}`;
