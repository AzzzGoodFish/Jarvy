/** Message IDs written in a message's text ("按 m2250 做", A82). People don't see IDs, so the page shows each one it can
 * resolve as a tag of that message. An ID is "m" and digits, not inside a longer word, number, path or file name;
 * Chinese text may touch it. */
export const MESSAGE_ID = /(?<![A-Za-z0-9_/#.@-])m\d{1,9}(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;
/** At most this many different IDs of one message are resolved; any further ones stay text. */
export const MESSAGE_REFS_MAX = 20;

/** The different message IDs in a text, in order of first appearance, at most MESSAGE_REFS_MAX. */
export function messageIds(text: string): string[] {
  const ids: string[] = [];
  for (const [id] of text.matchAll(MESSAGE_ID)) if (!ids.includes(id) && ids.push(id) >= MESSAGE_REFS_MAX) break;
  return ids;
}
