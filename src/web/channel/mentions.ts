import type { Member } from "../../contract/chat";
import { findMentions } from "../../contract/mentions";

/** Markdown with @mentions as highlight links (see Markdown in ui.tsx). */
export function linkMentions(text: string, members: readonly Member[], me: string): string {
  let out = "", last = 0;
  for (const hit of findMentions(text, members)) {
    out += text.slice(last, hit.at) + `[${text.slice(hit.at, hit.at + hit.length)}](${hit.member.id === me ? "#mention-me" : "#mention"})`;
    last = hit.at + hit.length;
  }
  return out + text.slice(last);
}
