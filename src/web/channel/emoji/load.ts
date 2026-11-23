import type { Emoji, EmojiGroup } from "./types";

/** Pre-tokenized search entry for one emoji, built once when the chunk loads so keystrokes avoid repeated allocations. */
export interface IndexedEmoji {
  readonly emoji: Emoji;
  readonly enNameParts: readonly string[];
  readonly enWords: readonly string[];
  readonly zhName: string;
  readonly zhNameParts: readonly string[];
  readonly zhWords: readonly string[];
  readonly wordCount: number;
}

/** Loaded emoji dataset: grouped for the panel, indexed by glyph for Recent lookup, and pre-tokenized for search. */
export interface EmojiCatalog {
  readonly groups: readonly EmojiGroup[];
  readonly byGlyph: ReadonlyMap<string, Emoji>;
  readonly all: readonly IndexedEmoji[];
}

function buildCatalog(groups: EmojiGroup[]): EmojiCatalog {
  const byGlyph = new Map<string, Emoji>();
  const all: IndexedEmoji[] = [];
  for (const group of groups) {
    for (const emoji of group.emoji) {
      byGlyph.set(emoji[0], emoji);
      const [, enName, enWords, zhName, zhWords] = emoji;
      const enWordList = enWords ? enWords.toLowerCase().split(" ") : [];
      const zhWordList = zhWords ? zhWords.split(" ") : [];
      all.push({
        emoji,
        enNameParts: enName.toLowerCase().split(/[\s:]+/),
        enWords: enWordList,
        zhName,
        zhNameParts: zhName.split(/:\s*/),
        zhWords: zhWordList,
        wordCount: Math.min(enWordList.length + zhWordList.length, 999),
      });
    }
  }
  return { groups, byGlyph, all };
}

/** The emoji list is about 210 KB, so it is its own chunk, prefetched when idle or on hover and kept in memory after
 * that. `peekEmoji` returns it synchronously once loaded so opening the picker never flashes an empty frame. */
let cached: EmojiCatalog | null = null;
let loading: Promise<EmojiCatalog> | undefined;

export function peekEmoji(): EmojiCatalog | null {
  return cached;
}

export function loadEmoji(): Promise<EmojiCatalog> {
  if (cached) return Promise.resolve(cached);
  loading ??= import("./data.json")
    .then(module => {
      const groups = (module.default as unknown as { groups: EmojiGroup[] }).groups;
      cached = buildCatalog(groups);
      return cached;
    })
    .catch(error => {
      loading = undefined;
      throw error;
    });
  return loading;
}

export function prefetchEmoji(): void {
  if (cached || loading) return;
  void loadEmoji().catch(() => { /* retried on next open */ });
}
