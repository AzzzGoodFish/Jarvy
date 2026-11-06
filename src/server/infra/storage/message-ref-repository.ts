import type { DatabaseSync } from "node:sqlite";
import type { MessageRef } from "../../../contract/chat.js";
import { messageIds } from "../../../contract/message-refs.js";
import { clipMarked } from "../../shared/quotes.js";
import type { QuoteRepository } from "./quote-repository.js";

type RefRow = { id: string; senderId: string; content: string; createdAt: number; chatId: string; type: MessageRef["chat"]["type"]; title: string; parentTitle: string | null };

/** The messages a text names by ID (A82) that a reader can see: what each one's tag and preview show. A message
 * never refers to itself; unknown IDs and messages the reader can't open are left out, so their text stays. */
export class MessageRefRepository {
  constructor(private readonly db: DatabaseSync, private readonly quotes: QuoteRepository) {}
  of(readerId: string, messageId: string, content: string): MessageRef[] {
    const ids = messageIds(content).filter(id => id !== messageId);
    if (!ids.length) return [];
    // Who may open a chat, as canAccess decides it: a thread follows its channel; the owner reads its Bots' DMs.
    // A DM is named by its Bots (its stored title is the start of its first message).
    const rows = this.db.prepare(`SELECT m.id,m.sender_id AS senderId,m.content,m.created_at AS createdAt,c.id AS chatId,c.type,p.title AS parentTitle,
      CASE WHEN c.type='dm' THEN COALESCE((SELECT group_concat(b.name,' · ') FROM chat_members d JOIN bots b ON b.id=d.member_id WHERE d.chat_id=c.id),c.title) ELSE c.title END AS title
      FROM messages m JOIN chats c ON c.id=m.chat_id LEFT JOIN chats p ON p.id=c.parent_id
      WHERE m.id IN (${ids.map(() => "?").join(",")}) AND (EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id=COALESCE(c.parent_id,c.id)
        AND cm.member_id=? AND cm.can_read=1) OR (c.type='dm' AND c.owner_id=?))`).all(...ids, readerId, readerId) as unknown as RefRow[];
    const found = new Map(rows.map(row => [row.id, row]));
    return ids.flatMap(id => {
      const row = found.get(id);
      return row ? [{ id, senderId: row.senderId, content: clipMarked(row.content, 200), quotes: this.quotes.of(id), createdAt: row.createdAt,
        chat: { id: row.chatId, type: row.type, title: row.title, parentTitle: row.parentTitle } }] : [];
    });
  }
}
