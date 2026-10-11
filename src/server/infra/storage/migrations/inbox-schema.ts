import type { DatabaseSync } from "node:sqlite";

/** v16 (A41): one inbox for everything delivered to a member, person or Bot. A row is
 * one delivery: what kind (message, reaction, note), why (reason) and how urgent (policy), with the Bot-side
 * lifecycle that `bot_pending` had (claimed by a run, then done / failed / …) or `bot_notices` had (told).
 * `bot_pending` and `bot_notices` are copied over and dropped; their old reasons were not stored, so a pending
 * message gets `dm` in a DM and `mention` elsewhere. `chat_states.muted` is a member's 免打扰 for a chat:
 * its DMs and subscriptions are queued for them instead of interrupting; @ and replies still interrupt.
 * Downgrading needs a v15 backup and matching program. */
export function migrateInbox(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 16) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('message','reaction','note')), reason TEXT NOT NULL,
        urgency TEXT NOT NULL CHECK(urgency IN ('interrupt','queue','digest')),
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES members(id), detail TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','told','done','failed','interrupted','unknown','cancelled')),
        run_id TEXT REFERENCES bot_runs(id), created_at INTEGER NOT NULL, told_at INTEGER);
      CREATE UNIQUE INDEX inbox_one_message ON inbox(member_id, message_id) WHERE kind='message';
      CREATE INDEX inbox_open ON inbox(member_id, state, id);
      CREATE INDEX inbox_run ON inbox(run_id) WHERE run_id IS NOT NULL;
      INSERT INTO inbox(member_id,kind,reason,urgency,chat_id,message_id,actor_id,state,run_id,created_at)
        SELECT p.bot_id,'message',CASE c.type WHEN 'dm' THEN 'dm' ELSE 'mention' END,'interrupt',m.chat_id,p.message_id,m.sender_id,p.state,p.run_id,p.created_at
        FROM bot_pending p JOIN messages m ON m.id=p.message_id JOIN chats c ON c.id=m.chat_id ORDER BY p.arrival_sequence;
      INSERT INTO inbox(member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,state,created_at,told_at)
        SELECT bot_id,'reaction','author','queue',chat_id,message_id,actor_id,emoji,CASE WHEN told_at IS NULL THEN 'pending' ELSE 'told' END,created_at,told_at
        FROM bot_notices ORDER BY id;
      ALTER TABLE chat_states ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1));
      DROP TABLE bot_pending;
      DROP TABLE bot_notices;
      PRAGMA user_version=16;
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
