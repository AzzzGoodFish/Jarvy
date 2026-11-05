/** One emoji with its CLDR names and keywords, in English and Chinese (scripts/build-emoji.mjs writes them). */
export type Emoji = readonly [emoji: string, enName: string, enWords: string, zhName: string, zhWords: string];

/** The Unicode groups the panel lists, in order. */
export type GroupName = "Smileys & Emotion" | "People & Body" | "Animals & Nature" | "Food & Drink" | "Travel & Places"
  | "Activities" | "Objects" | "Symbols" | "Flags";

export interface EmojiGroup {
  name: GroupName;
  emoji: Emoji[];
}
