import type { DatabaseSync } from "node:sqlite";

/** v22 (A56): scheduled tasks. `tasks` holds one Bot's tasks: its name and instruction, the schedule as
 * `schedule_kind` plus the one field that kind uses, its state, and when it next runs and last ran. `inbox.kind`
 * gains `task` (the task was due); SQLite can't change a CHECK in place, so the table is rebuilt with its rows,
 * indexes and id sequence, as v19 did. `chat_id` must be a chat the Bot can read; the caller checks.
 * Downgrading needs a v21 backup and matching program. */
export function migrateTasks(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 22) return;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    const sequence = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get() as { seq: number } | undefined)?.seq ?? 0;
    db.exec(`
      CREATE TABLE tasks(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, name TEXT NOT NULL, instruction TEXT NOT NULL,
        schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('once','every','daily','weekly')),
        schedule_at INTEGER, schedule_minutes INTEGER, schedule_hour INTEGER, schedule_minute INTEGER, schedule_weekday INTEGER,
        state TEXT NOT NULL CHECK(state IN ('active','paused','done')),
        next_run_at INTEGER, last_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE INDEX tasks_due ON tasks(state, next_run_at) WHERE deleted_at IS NULL;
      CREATE INDEX tasks_bot ON tasks(bot_id) WHERE deleted_at IS NULL;
      CREATE TABLE inbox_next(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('message','reaction','note','onboard','change','task')), reason TEXT NOT NULL,
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
    db.exec("PRAGMA user_version=22");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
}
