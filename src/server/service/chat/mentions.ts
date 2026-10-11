/** @ is taken from the message text: "@name" mentions the member with that name.
 * The longest name wins (so "@阿构请" prefers a member "阿构请" over "阿构"); a name ending in a Latin
 * letter or digit must not run into another one ("@Jarvyx" is not Jarvy); "a@b" is not a mention;
 * an @ inside a code span or block is not a mention. */
const WORD = /[\p{Script=Latin}\p{Nd}_]/u;
export function findMentions<T extends { id: string; name: string }>(source: string, candidates: readonly T[]): T[] {
  const text = source.replace(/```[\s\S]*?```|`[^`\n]*`/g, code => " ".repeat(code.length));
  const lower = text.toLowerCase(), sorted = [...candidates].sort((a, b) => b.name.length - a.name.length), found: T[] = [];
  for (let at = lower.indexOf("@"); at >= 0; at = lower.indexOf("@", at + 1)) {
    if (at > 0 && WORD.test(text[at - 1]!)) continue;
    const match = sorted.find(candidate => {
      const name = candidate.name.toLowerCase();
      if (!name || !lower.startsWith(name, at + 1)) return false;
      const next = text[at + 1 + name.length];
      return !(next && WORD.test(next) && WORD.test(name.at(-1)!));
    });
    if (match && !found.includes(match)) found.push(match);
  }
  return found;
}
