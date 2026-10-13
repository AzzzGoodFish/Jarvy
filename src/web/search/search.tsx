import { useEffect, useState } from "react";
import { api, type Chat, type ChatMessage, type Member, type SearchResult } from "../api";
import { formatClock, formatDay, t } from "../i18n";
import { memberName } from "../members";
import { quotedText } from "../channel/quotes";

/** Searches as you type (250 ms after the last key); null while there is nothing to show yet. */
export function useSearch(query: string, within: string | undefined, onError: (error: unknown) => void) {
  const [result, setResult] = useState<SearchResult | null>(null), [loading, setLoading] = useState(false);
  useEffect(() => {
    const text = query.trim();
    if (!text) { setResult(null); setLoading(false); return; }
    let alive = true; setLoading(true);
    const timer = setTimeout(() => void api.search(text, within).then(found => { if (alive) setResult(found); })
      .catch(error => { if (alive) onError(error); }).finally(() => { if (alive) setLoading(false); }), 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, within]);
  return { result, loading };
}

/** Where a message is, for a result line: 「#频道」, 「#频道 › 线程标题」 or the Bot's name for a DM. */
export function placeOf(chat: Chat, chats: Chat[], members: Member[]): string {
  if (chat.type === "thread") return `#${chats.find(item => item.id === chat.parentId)?.title ?? t("search.channel")} › ${chat.title}`;
  if (chat.type === "channel") return `#${chat.title}`;
  return memberName(members.find(member => member.id === chat.botId));
}

/** The text around the first hit, Markdown marks dropped, the hit marked. */
export function Snippet({ text, query, room = 24 }: { text: string; query: string; room?: number }) {
  const plain = text.replace(/[*`~#>|]/g, "").replace(/\s+/g, " ").trim();
  const at = plain.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (at < 0 || !query.trim()) return <>{plain.slice(0, 120)}</>;
  const start = Math.max(0, at - room), end = at + query.trim().length;
  return <>{start > 0 && "…"}{plain.slice(start, at)}<mark className="jv-hit">{plain.slice(at, end)}</mark>{plain.slice(end, end + 120)}</>;
}

const when = (time: number) => new Date(time).toDateString() === new Date().toDateString() ? formatClock(time) : formatDay(time);

/** One message found: who, where (unless searching inside that chat), when, and the text around the hit. */
export function MessageHit({ message, chat, chats, members, query, showPlace = true, onOpen }: {
  message: ChatMessage; chat: Chat; chats: Chat[]; members: Member[]; query: string; showPlace?: boolean;
  onOpen: (chat: Chat, messageId: string) => void;
}) {
  return <button type="button" className="jv-hit-row" onClick={() => onOpen(chat, message.id)}>
    <span className="jv-hit-head"><strong>{memberName(members.find(member => member.id === message.senderId))}</strong>
      {showPlace && <span className="jv-hit-place">{placeOf(chat, chats, members)}</span>}
      <time dateTime={new Date(message.createdAt).toISOString()}>{when(message.createdAt)}</time></span>
    <span className="jv-hit-text"><Snippet text={quotedText(message)} query={query}/></span>
  </button>;
}
