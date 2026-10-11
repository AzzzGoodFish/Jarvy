import type { Member } from "../api";

/** Same rule as the server (service/chat/mentions.ts; web cannot import server code): "@name" with the
 * longest matching name; a Latin/digit name must not run into another Latin/digit; "a@b" is not a mention;
 * an @ inside a code span or block is not a mention. */
const WORD = /[\p{Script=Latin}\p{Nd}_]/u;
export function findMentions(source: string, candidates: readonly Member[]): { member: Member; at: number; length: number }[] {
  const text = source.replace(/```[\s\S]*?```|`[^`\n]*`/g, code => " ".repeat(code.length));
  const lower = text.toLowerCase(), sorted = [...candidates].sort((a, b) => b.name.length - a.name.length), found: { member: Member; at: number; length: number }[] = [];
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
/** Markdown with @mentions as highlight links (see Markdown in ui.tsx). */
export function linkMentions(text: string, members: readonly Member[], me: string): string {
  let out = "", last = 0;
  for (const hit of findMentions(text, members)) {
    out += text.slice(last, hit.at) + `[${text.slice(hit.at, hit.at + hit.length)}](${hit.member.id === me ? "#mention-me" : "#mention"})`;
    last = hit.at + hit.length;
  }
  return out + text.slice(last);
}
