import type { DatabaseSync } from "node:sqlite";
import { CATEGORY, type Delivery, type DeliveryKind, type DeliveryPayloads, type Urgency } from "../../shared/delivery.js";
import type { ChatHint, MemberIdentity } from "../../shared/chat.js";
import type { ChatRepository } from "./chat-repository.js";

/** One row to write: a planned delivery, where it is (a chat and message for the chat categories, none for a system
 * notice, A61), who caused it and what its kind carries. */
export interface InboxEntry<K extends DeliveryKind = DeliveryKind> {
  delivery: Pick<Delivery, "reason" | "urgency"> & { kind: K; member: { id: string } }; chatId: string | null; messageId: string | null; actorId: string | null; payload: DeliveryPayloads[K]; createdAt: number;
}
/** A delivery that is not a message and the Bot has not been told (A41): a mark or a new notice / summary version, in
 * the chat it is about; or a system notice (A61), about no chat. `payload` is as its kind writes it. */
export type BotNotice = { [K in Exclude<DeliveryKind, "message">]: { id: number; kind: K; urgency: Urgency; createdAt: number;
  /** Who did it; none for a task, which the scheduler delivers (A58). */
  actor: MemberIdentity | null; payload: DeliveryPayloads[K];
  chat: K extends "reaction" | "note" ? { id: string; type: "dm" | "channel" | "thread"; title: string } : null;
  messageId: K extends "reaction" ? string : null } }[Exclude<DeliveryKind, "message">];
type NoticeRow = { id: number; kind: Exclude<DeliveryKind, "message">; urgency: Urgency; chatId: string | null; chatTitle: string | null; chatType: string | null;
  messageId: string | null; actorId: string | null; payload: string | null; createdAt: number };

/** SQL condition for a message `m` already handed to the Bot `:member` (A37: that counts as read for a Bot). */
export const HANDED_TO_BOT = "EXISTS(SELECT 1 FROM inbox i JOIN bots b ON b.id=i.member_id WHERE i.member_id=:member AND i.category='message' AND i.message_id=m.id)";

/** The inbox (v16, v26): every delivery to every member, the one place its SQL lives. A source writes rows with the fact
 * they are about, in its own transaction; a Bot's message rows follow its runs, everything else is told once; a
 * person's rows are what their chat rows show. */
export class InboxRepository {
  constructor(private readonly db: DatabaseSync, private readonly chats: ChatRepository) {}

  /** Writes rows inside the caller's transaction. The category comes from the kind, and the CHECKs refuse a chat row
   * without its chat or a system row with one. */
  write(entries: readonly InboxEntry[]): void {
    const insert = this.db.prepare(`INSERT INTO inbox(member_id,category,kind,reason,urgency,chat_id,message_id,actor_id,payload,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const { delivery, chatId, messageId, actorId, payload, createdAt } of entries)
      insert.run(delivery.member.id, CATEGORY[delivery.kind], delivery.kind, delivery.reason, delivery.urgency, chatId, messageId, actorId,
        payload === null ? null : JSON.stringify(payload), createdAt);
  }
  /** A mark removed before it was told takes its row back. */
  withdrawReaction(messageId: string, actorId: string, emoji: string): void {
    this.db.prepare(`DELETE FROM inbox WHERE message_id=? AND actor_id=? AND kind='reaction' AND state='pending' AND json_extract(payload,'$.emoji')=?`)
      .run(messageId, actorId, emoji);
  }
  /** A deleted member's rows go with it. */
  forget(memberId: string): void { this.db.prepare("DELETE FROM inbox WHERE member_id=?").run(memberId); }

  // A Bot's messages, claimed by its runs.
  /** Bots with deliveries still waiting at startup, each with the most urgent of them (A41). */
  waitingBots(ownerId: string): { botId: string; urgency: "interrupt" | "queue" }[] {
    return this.db.prepare(`SELECT i.member_id AS botId,CASE WHEN SUM(i.urgency='interrupt')>0 THEN 'interrupt' ELSE 'queue' END AS urgency
      FROM inbox i JOIN bots b ON b.id=i.member_id WHERE b.owner_id=? AND b.deleted_at IS NULL AND i.state='pending' AND i.urgency IN ('interrupt','queue')
      GROUP BY i.member_id ORDER BY i.member_id`).all(ownerId) as { botId: string; urgency: "interrupt" | "queue" }[];
  }
  hasPendingMessages(botId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM inbox WHERE member_id=? AND category='message' AND state='pending' LIMIT 1").get(botId);
  }
  /** Inside a claim: messages in chats the Bot can no longer read are cancelled, the rest are listed in order. */
  pendingMessages(botId: string): { chatId: string; messageId: string }[] {
    this.db.prepare(`UPDATE inbox SET state='cancelled' WHERE member_id=? AND category='message' AND state='pending' AND message_id NOT IN
      (SELECT m.id FROM messages m JOIN chats c ON c.id=m.chat_id
        JOIN chat_members cm ON cm.chat_id=COALESCE(c.parent_id,c.id) AND cm.member_id=? AND cm.can_read=1)`).run(botId, botId);
    return this.db.prepare(`SELECT chat_id AS chatId,message_id AS messageId FROM inbox
      WHERE member_id=? AND category='message' AND state='pending' ORDER BY id`).all(botId) as { chatId: string; messageId: string }[];
  }
  claimMessages(botId: string, runId: string): void {
    this.db.prepare("UPDATE inbox SET state='claimed',run_id=? WHERE member_id=? AND category='message' AND state='pending'").run(runId, botId);
  }
  /** The run ended: its messages take its outcome. */
  settleRun(runId: string, state: string): void { this.db.prepare("UPDATE inbox SET state=? WHERE run_id=?").run(state, runId); }
  /** A run that never reached the model gives its messages back. */
  releaseRun(runId: string): void { this.db.prepare("UPDATE inbox SET state='pending',run_id=NULL WHERE run_id=? AND state='claimed'").run(runId); }
  /** At start, inside the caller's transaction and before the runs are marked: claimed rows go back to pending, rows of
   * runs that reached the model are unknown. */
  recover(): void {
    this.db.exec(`UPDATE inbox SET state='pending',run_id=NULL WHERE run_id IN (SELECT id FROM bot_runs WHERE state='claimed');
      UPDATE inbox SET state='unknown' WHERE run_id IN (SELECT id FROM bot_runs WHERE state='submitted');`);
  }

  // A Bot's other deliveries, told once.
  /** Not told yet, oldest first: activity in chats the Bot can still read, and its system notices. */
  notices(botId: string): BotNotice[] {
    const rows = this.db.prepare(`SELECT n.id,n.kind,n.urgency,n.chat_id AS chatId,c.title AS chatTitle,c.type AS chatType,n.message_id AS messageId,
        n.actor_id AS actorId,n.payload,n.created_at AS createdAt
      FROM inbox n LEFT JOIN chats c ON c.id=n.chat_id WHERE n.member_id=? AND n.category<>'message' AND n.state='pending' ORDER BY n.id`).all(botId) as NoticeRow[];
    return rows.filter(row => row.chatId === null || this.chats.canAccess(botId, row.chatId)).map(row => ({
      id: row.id, kind: row.kind, urgency: row.urgency, createdAt: row.createdAt, actor: row.actorId ? this.chats.member(row.actorId) : null,
      payload: row.payload === null ? null : JSON.parse(row.payload), messageId: row.messageId,
      chat: row.chatId === null ? null : { id: row.chatId, type: row.chatType as "dm" | "channel" | "thread", title: row.chatTitle ?? "" } }) as BotNotice);
  }
  /** These notices reached the Bot (steered into its run, or in a batch it was given). */
  tell(botId: string, ids: readonly number[]): void {
    const now = Date.now();
    for (const id of ids) {
      this.db.prepare("UPDATE inbox SET state='told',told_at=? WHERE id=? AND member_id=? AND state='pending'").run(now, id, botId);
      // Being told of a new notice / summary version is knowing it (A37 note_seen).
      this.db.prepare(`INSERT INTO chat_states(chat_id,member_id,note_seen) SELECT chat_id,member_id,json_extract(payload,'$.version') FROM inbox WHERE id=? AND kind='note'
        ON CONFLICT(chat_id,member_id) DO UPDATE SET note_seen=MAX(note_seen,excluded.note_seen)`).run(id);
    }
  }

  // A person's rows: what their chat list shows.
  /** What a person's chat row shows (A41): unread interrupt messages, and the newest queued activity. */
  rowState(memberId: string, chatId: string): { alerts: number; atMe: boolean; hint: ChatHint | null } {
    const counts = this.db.prepare(`SELECT count(*) AS n,COALESCE(SUM(reason IN ('mention','reply')),0) AS at FROM inbox
      WHERE member_id=? AND chat_id=? AND category='message' AND urgency='interrupt' AND state='pending'`).get(memberId, chatId) as { n: number; at: number };
    const row = this.db.prepare(`SELECT i.kind,i.chat_id AS chatId,c.type AS chatType,c.title,i.actor_id AS actorId,i.payload,i.created_at AS createdAt
      FROM inbox i JOIN chats c ON c.id=i.chat_id
      WHERE i.member_id=? AND i.category='activity' AND i.urgency='queue' AND i.state='pending' AND (i.chat_id=? OR c.parent_id=?) ORDER BY i.id DESC LIMIT 1`)
      .get(memberId, chatId, chatId) as { kind: "reaction" | "note"; chatId: string; chatType: string; title: string; actorId: string | null; payload: string | null; createdAt: number } | undefined;
    if (!row) return { alerts: counts.n, atMe: counts.at > 0, hint: null };
    const payload = row.payload ? JSON.parse(row.payload) as { emoji?: string; version?: number } : {};
    const detail = row.kind === "reaction" ? payload.emoji ?? "" : String(payload.version ?? "");
    return { alerts: counts.n, atMe: counts.at > 0, hint: { kind: row.kind, chatId: row.chatId, chatType: row.chatType, title: row.title,
      actor: (row.actorId && this.chats.member(row.actorId)?.name) || "", detail, createdAt: row.createdAt } };
  }
  /** A person read up to `sequence` in a chat: the messages delivered to them there are told. */
  readUpTo(memberId: string, chatId: string, sequence: number): void {
    this.db.prepare(`UPDATE inbox SET state='told',told_at=? WHERE member_id=? AND category='message' AND state='pending'
      AND chat_id=? AND message_id IN (SELECT id FROM messages WHERE chat_id=? AND sequence<=?)`).run(Date.now(), memberId, chatId, chatId, sequence);
  }
  /** A person opened a chat: its queued activity (and its threads', for a channel) counts as seen. */
  seenIn(memberId: string, chatId: string): void {
    this.db.prepare(`UPDATE inbox SET state='told',told_at=? WHERE member_id=? AND category='activity' AND state='pending'
      AND chat_id IN (SELECT id FROM chats WHERE id=? OR parent_id=?)`).run(Date.now(), memberId, chatId, chatId);
  }
}
