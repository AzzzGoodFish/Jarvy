/** @ is taken from the message text (A37): "@name" mentions the member with that name. The server decides with it who
 * is mentioned and told; the web highlights the same names and warns about names outside the chat, so both use this.
 * The longest name wins (so "@阿构请" prefers a member "阿构请" over "阿构"); a name ending in a Latin letter or digit must
 * not run into another one ("@Jarvyx" is not Jarvy); "a@b" is not a mention; an @ inside a code span or block is not a
 * mention; a mention's text is not searched again. */
const WORD = /[\p{Script=Latin}\p{Nd}_]/u;
export interface MentionHit<T> { member: T; at: number; length: number }
/** Every mention, where it is in the text and how long it is ("@" and the name). */
export function findMentions<T extends { id: string; name: string }>(source: string, candidates: readonly T[]): MentionHit<T>[] {
  const text = source.replace(/```[\s\S]*?```|`[^`\n]*`/g, code => " ".repeat(code.length));
  const lower = text.toLowerCase(), sorted = [...candidates].sort((a, b) => b.name.length - a.name.length), found: MentionHit<T>[] = [];
  for (let at = lower.indexOf("@"); at >= 0; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && WORD.test(text[at - 1]!)) continue;
    const member = sorted.find(candidate => {
      const name = candidate.name.toLowerCase();
      if (!name || !lower.startsWith(name, at + 1)) return false;
      const next = text[at + 1 + name.length];
      return !(next && WORD.test(next) && WORD.test(name.at(-1)!));
    });
    if (member) { found.push({ member, at, length: member.name.length + 1 }); at += member.name.length; }
  }
  return found;
}
/** The members mentioned, each once, in the order first mentioned. */
export function mentionedMembers<T extends { id: string; name: string }>(source: string, candidates: readonly T[]): T[] {
  return [...new Set(findMentions(source, candidates).map(hit => hit.member))];
}
