import type { DatabaseSync } from "node:sqlite";
import type { Delivery } from "../../shared/delivery.js";
import { ChatError } from "../../shared/chat.js";
import type { ChatRepository } from "./chat-repository.js";
import { transaction } from "./transaction.js";

/** Emoji marks, pins, mutes and folds (v15). A mark never interrupts a run; its author gets the routed delivery,
 * written to the inbox in the same transaction as the mark. */
export class InteractionRepository {
  constructor(private readonly db: DatabaseSync, private readonly chats: ChatRepository) {}

  /** Grouped by emoji, in the order each emoji was first used. */
  reactions(messageId: string): { emoji: string; memberIds: string[] }[] {
    const rows = this.db.prepare("SELECT emoji,member_id AS memberId FROM message_reactions WHERE message_id=? ORDER BY created_at,rowid").all(messageId) as { emoji: string; memberId: string }[];
    const groups = new Map<string, string[]>();
    for (const row of rows) groups.set(row.emoji, [...groups.get(row.emoji) ?? [], row.memberId]);
    return [...groups].map(([emoji, memberIds]) => ({ emoji, memberIds }));
  }
  /** Adds or removes the actor's mark (anyone who can write in the chat), writing the routed deliveries with a new
   * mark (A41). `added` is false when the mark was already there. Removing a mark withdraws what was not told yet. */
  /** Whether this member already has this emoji on this message. */
  reactionOn(actorId: string, messageId: string, emoji: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM message_reactions WHERE message_id=? AND member_id=? AND emoji=?").get(messageId, actorId, emoji);
  }
  react(actorId: string, messageId: string, emoji: string, on: boolean, deliveries: readonly Delivery[]): { chatId: string; added: boolean } {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT chat_id AS chatId FROM messages WHERE id=?").get(messageId) as { chatId: string } | undefined;
      if (!row || !this.chats.canAccess(actorId, row.chatId, true)) throw new ChatError(404, "Message not found");
      if (on) {
        const added = Number(this.db.prepare("INSERT OR IGNORE INTO message_reactions(message_id,member_id,emoji,created_at) VALUES(?,?,?,?)").run(messageId, actorId, emoji, Date.now()).changes) > 0;
        if (added) this.chats.inbox.write(deliveries.map(delivery => ({ delivery, chatId: row.chatId, messageId, actorId, payload: { emoji }, createdAt: Date.now() })));
        return { chatId: row.chatId, added };
      }
      this.db.prepare("DELETE FROM message_reactions WHERE message_id=? AND member_id=? AND emoji=?").run(messageId, actorId, emoji);
      this.chats.inbox.withdrawReaction(messageId, actorId, emoji);
      return { chatId: row.chatId, added: false };
    });
  }
  /** 免打扰 for one member and chat. */
  setMuted(memberId: string, chatId: string, muted: boolean): void {
    this.chats.assertAccess(memberId, chatId);
    this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,muted) VALUES(?,?,?)
      ON CONFLICT(chat_id,member_id) DO UPDATE SET muted=excluded.muted`).run(chatId, memberId, muted ? 1 : 0);
  }
  /** Members who muted a chat; a thread follows its channel's 免打扰 too. A route input (A41). */
  mutedIn(chatId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT member_id AS id FROM chat_states WHERE muted=1 AND chat_id IN
      (SELECT id FROM chats WHERE id=? UNION SELECT parent_id FROM chats WHERE id=? AND parent_id IS NOT NULL)`).all(chatId, chatId) as { id: string }[]).map(row => row.id);
  }
  /** Folds a message to one line in the interface, or unfolds it (A60); its content and everything else stay. */
  setFolded(messageId: string, folded: boolean): void {
    this.db.prepare("UPDATE messages SET folded_at=? WHERE id=?").run(folded ? Date.now() : null, messageId);
  }
  setPinned(memberId: string, chatId: string, pinned: boolean): void {
    this.chats.assertAccess(memberId, chatId);
    this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,pinned) VALUES(?,?,?)
      ON CONFLICT(chat_id,member_id) DO UPDATE SET pinned=excluded.pinned`).run(chatId, memberId, pinned ? 1 : 0);
  }
}
