import type { DatabaseSync } from "node:sqlite";
import type { Delivery, Urgency } from "../../shared/delivery.js";
import { ChatError, type ChatHint, type MemberIdentity } from "../../shared/chat.js";
import type { ChatRepository } from "./chat-repository.js";

/** A delivery that is not a message (A41): a mark on the member's message (`detail` = emoji), a new version of a
 * notice / summary (`detail` = version, no message), or for a Bot from the agent service (A48) the request to welcome
 * the owner (`detail` = interface language) or a change the agent made to it (`detail` = JSON {what, value}). */
export interface BotNotice { id: number; kind: "reaction" | "note" | "onboard" | "change" | "task"; urgency: Urgency; chatId: string; chatTitle: string; chatType: string; messageId: string | null;
  /** Who did it; none for a task, which the scheduler delivers (A58, `detail` = JSON {task, due}). */
  actor: MemberIdentity | null; detail: string; createdAt: number; }

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Emoji marks, pins and Bot notices (v15). A mark never interrupts a run; the
 * author of a marked message, when it is a Bot, gets a notice written in the same transaction as the mark. */
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
    return inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT chat_id AS chatId FROM messages WHERE id=?").get(messageId) as { chatId: string } | undefined;
      if (!row || !this.chats.canAccess(actorId, row.chatId, true)) throw new ChatError(404, "Message not found");
      if (on) {
        const added = Number(this.db.prepare("INSERT OR IGNORE INTO message_reactions(message_id,member_id,emoji,created_at) VALUES(?,?,?,?)").run(messageId, actorId, emoji, Date.now()).changes) > 0;
        if (added) for (const delivery of deliveries) this.db.prepare(`INSERT INTO inbox(member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(delivery.member.id, delivery.kind, delivery.reason, delivery.urgency, row.chatId, messageId, actorId, emoji, Date.now());
        return { chatId: row.chatId, added };
      }
      this.db.prepare("DELETE FROM message_reactions WHERE message_id=? AND member_id=? AND emoji=?").run(messageId, actorId, emoji);
      this.db.prepare("DELETE FROM inbox WHERE message_id=? AND actor_id=? AND detail=? AND kind='reaction' AND state='pending'").run(messageId, actorId, emoji);
      return { chatId: row.chatId, added: false };
    });
  }
  /** Notices the Bot has not been told, oldest first, in chats it can still read. */
  notices(botId: string): BotNotice[] {
    const rows = this.db.prepare(`SELECT n.id,n.kind,n.urgency,n.chat_id AS chatId,c.title AS chatTitle,c.type AS chatType,n.message_id AS messageId,n.actor_id AS actorId,n.detail,n.created_at AS createdAt
      FROM inbox n JOIN chats c ON c.id=n.chat_id WHERE n.member_id=? AND n.kind<>'message' AND n.state='pending' ORDER BY n.id`).all(botId) as (Omit<BotNotice, "actor"> & { actorId: string | null })[];
    return rows.filter(row => this.chats.canAccess(botId, row.chatId)).map(({ actorId, ...row }) => ({ ...row, actor: actorId ? this.chats.member(actorId) : null }));
  }
  /** These notices reached the Bot (steered into its run, or in a batch it was given). */
  tell(botId: string, ids: readonly number[]): void {
    const now = Date.now();
    for (const id of ids) {
      this.db.prepare("UPDATE inbox SET state='told',told_at=? WHERE id=? AND member_id=? AND state='pending'").run(now, id, botId);
      // Being told of a new notice / summary version is knowing it (A37 note_seen).
      this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,note_seen) SELECT chat_id,member_id,CAST(detail AS INTEGER) FROM inbox WHERE id=? AND kind='note'
        ON CONFLICT(chat_id,member_id) DO UPDATE SET note_seen=MAX(note_seen,excluded.note_seen)`).run(id);
    }
  }
  /** What a person's chat row shows (A41): unread interrupt deliveries, and the newest queued one. */
  rowState(memberId: string, chatId: string): { alerts: number; atMe: boolean; hint: ChatHint | null } {
    const counts = this.db.prepare(`SELECT count(*) AS n,COALESCE(SUM(reason IN ('mention','reply')),0) AS at FROM inbox
      WHERE member_id=? AND chat_id=? AND kind='message' AND urgency='interrupt' AND state='pending'`).get(memberId, chatId) as { n: number; at: number };
    const row = this.db.prepare(`SELECT i.kind,i.chat_id AS chatId,c.type AS chatType,c.title,i.actor_id AS actorId,i.detail,i.created_at AS createdAt FROM inbox i JOIN chats c ON c.id=i.chat_id
      WHERE i.member_id=? AND i.kind<>'message' AND i.urgency='queue' AND i.state='pending' AND (i.chat_id=? OR c.parent_id=?) ORDER BY i.id DESC LIMIT 1`).get(memberId, chatId, chatId) as
      { kind: "reaction" | "note"; chatId: string; chatType: string; title: string; actorId: string | null; detail: string | null; createdAt: number } | undefined;
    const hint = row ? { kind: row.kind, chatId: row.chatId, chatType: row.chatType, title: row.title, actor: (row.actorId && this.chats.member(row.actorId)?.name) || "", detail: row.detail ?? "", createdAt: row.createdAt } : null;
    return { alerts: counts.n, atMe: counts.at > 0, hint };
  }
  /** A person opened a chat: its queued deliveries (and its threads', for a channel) count as seen. */
  seenIn(memberId: string, chatId: string): void {
    this.db.prepare(`UPDATE inbox SET state='told',told_at=? WHERE member_id=? AND kind<>'message' AND state='pending'
      AND chat_id IN (SELECT id FROM chats WHERE id=? OR parent_id=?)`).run(Date.now(), memberId, chatId, chatId);
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
