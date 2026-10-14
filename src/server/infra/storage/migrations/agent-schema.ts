import type { DatabaseSync } from "node:sqlite";
import { AGENT_BOT_ID } from "../../../shared/models.js";

/** v19 (A48): instance settings by key, and two more kinds of delivery for Bots. `settings` starts with
 * `agent_onboarded` (when the agent Bot was first given a model and asked to welcome the owner); an agent that already
 * has a model counts as onboarded, so an upgrade sends no welcome. `inbox.kind` gains `onboard` (that request) and
 * `change` (the agent changed a Bot's settings); SQLite can't change a CHECK in place, so the table is rebuilt with its
 * rows, indexes and id sequence. Downgrading needs a v18 backup and matching program. */
export function migrateAgent(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 19) return;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    const sequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get() as { seq: number } | undefined)?.seq ?? 0;
    db.exec(`
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE inbox_next(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('message','reaction','note','onboard','change')), reason TEXT NOT NULL,
        urgency TEXT NOT NULL CHECK(urgency IN ('interrupt','queue','digest')),
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES members(id), detail TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','told','done','failed','interrupted','unknown','cancelled')),
        run_id TEXT REFERENCES bot_runs(id), created_at INTEGER NOT NULL, told_at INTEGER);
      INSERT INTO inbox_next(id,member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,state,run_id,created_at,told_at)
        SELECT id,member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,state,run_id,created_at,told_at FROM inbox ORDER BY id;
      DROP TABLE inbox;
      ALTER TABLE inbox_next RENAME TO inbox;
      CREATE UNIQUE INDEX inbox_one_message ON inbox(member_id, message_id) WHERE kind='message';
      CREATE INDEX inbox_open ON inbox(member_id, state, id);
      CREATE INDEX inbox_run ON inbox(run_id) WHERE run_id IS NOT NULL;
    `);
    db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='inbox'").run(sequence);
    db.prepare(`INSERT INTO settings(key,value) SELECT 'agent_onboarded',? FROM bots
      WHERE id=? AND deleted_at IS NULL AND connection_id IS NOT NULL`).run(String(Date.now()), AGENT_BOT_ID);
    db.exec("PRAGMA user_version=19");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
}
