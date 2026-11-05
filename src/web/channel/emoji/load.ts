import type { EmojiGroup } from "./types";

/** The emoji list is 175 KB, so it is its own chunk, fetched the first time someone opens the panel and kept after
 * that. The quick row and the search box work before it arrives. */
let loading: Promise<EmojiGroup[]> | undefined;
export function loadEmoji(): Promise<EmojiGroup[]> {
  // JSON types its rows as plain arrays; the generator writes exactly three strings to each.
  loading ??= import("./data.json").then(module => (module.default as unknown as { groups: EmojiGroup[] }).groups);
  return loading;
}
