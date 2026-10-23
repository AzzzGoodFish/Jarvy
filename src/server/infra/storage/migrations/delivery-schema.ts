import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v26 (A61): deliveries come in three categories. `category` is `message` (a chat message: chat and message), `activity`
 * (a mark or a new notice / summary version: a chat, and the marked message) or `system` (a notice to one member about
 * no chat: the agent's welcome, a settings change, a due task — neither chat nor message). `chat_id` is required only
 * for the chat categories; CHECKs keep that. `kind` is no longer listed in a CHECK, so a new kind needs no rebuild;
 * the code checks it. `detail` becomes `payload`, JSON shaped by kind ({emoji}, {version}, {language}, {what, value},
 * {task, due}). Rows move as they are, except that system rows drop the DM they borrowed. The table is rebuilt with
 * its rows, indexes and id sequence, as v19 and v23 did. Downgrading needs a v25 backup and matching program. */
export function migrateDeliveries(db: DatabaseSync): void {
  migration(db, 26, () => {
    const sequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get() as { seq: number } | undefined)?.seq ?? 0;
    db.exec(`
      CREATE TABLE inbox_next(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
        category TEXT NOT NULL CHECK(category IN ('message','activity','system')), kind TEXT NOT NULL, reason TEXT NOT NULL,
        urgency TEXT NOT NULL CHECK(urgency IN ('interrupt','queue','digest')),
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES members(id), payload TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','told','done','failed','interrupted','unknown','cancelled')),
        run_id TEXT REFERENCES bot_runs(id), created_at INTEGER NOT NULL, told_at INTEGER,
        CHECK(category='system' OR chat_id IS NOT NULL),
        CHECK(category<>'system' OR (chat_id IS NULL AND message_id IS NULL)),
        CHECK(category<>'message' OR message_id IS NOT NULL));
      INSERT INTO inbox_next(id,member_id,category,kind,reason,urgency,chat_id,message_id,actor_id,payload,state,run_id,created_at,told_at)
        SELECT id,member_id,
          CASE WHEN kind='message' THEN 'message' WHEN kind IN ('reaction','note') THEN 'activity' ELSE 'system' END,
          kind,reason,urgency,
          CASE WHEN kind IN ('onboard','change','task') THEN NULL ELSE chat_id END,
          CASE WHEN kind IN ('onboard','change','task') THEN NULL ELSE message_id END,
          actor_id,
          CASE kind WHEN 'reaction' THEN json_object('emoji',detail) WHEN 'note' THEN json_object('version',CAST(detail AS INTEGER))
            WHEN 'onboard' THEN json_object('language',detail) ELSE detail END,
          state,run_id,created_at,told_at FROM inbox ORDER BY id;
      DROP TABLE inbox;
      ALTER TABLE inbox_next RENAME TO inbox;
      CREATE UNIQUE INDEX inbox_one_message ON inbox(member_id, message_id) WHERE category='message';
      CREATE INDEX inbox_open ON inbox(member_id, state, id);
      CREATE INDEX inbox_run ON inbox(run_id) WHERE run_id IS NOT NULL;
    `);
    db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='inbox'").run(sequence);
  }, { rebuild: true });
}
