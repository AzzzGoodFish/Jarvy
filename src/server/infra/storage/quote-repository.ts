import type { DatabaseSync } from "node:sqlite";
import type { MessageQuote } from "../../../contract/chat.js";

/** A message's partial quotes (A44, v17), in mark order. */
export class QuoteRepository {
  constructor(private readonly db: DatabaseSync) {}
  /** Inside the caller's transaction. */
  insert(messageId: string, quotes: readonly MessageQuote[]): void {
    quotes.forEach((quote, index) => this.db.prepare("INSERT INTO message_quotes(message_id,position,source_id,source_sender_id,text) VALUES(?,?,?,?,?)")
      .run(messageId, index + 1, quote.messageId, quote.senderId, quote.text));
  }
  of(messageId: string): MessageQuote[] {
    return this.db.prepare("SELECT source_id AS messageId,source_sender_id AS senderId,text FROM message_quotes WHERE message_id=? ORDER BY position")
      .all(messageId) as unknown as MessageQuote[];
  }
}
