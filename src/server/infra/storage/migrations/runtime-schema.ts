import type { DatabaseSync } from "node:sqlite";

export function migrateRuntime(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 6) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE bot_sessions(bot_id TEXT PRIMARY KEY REFERENCES bots(id), file TEXT NOT NULL UNIQUE,
        runtime_session_id TEXT, persisted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE bot_runs(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
        state TEXT NOT NULL CHECK(state IN ('claimed','submitted','completed','failed','interrupted','unknown','cancelled')),
        selection_json TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER, error_code TEXT);
      CREATE INDEX bot_runs_recent ON bot_runs(bot_id,created_at DESC);
      CREATE UNIQUE INDEX bot_one_active_run ON bot_runs(bot_id) WHERE state IN ('claimed','submitted');
      ALTER TABLE bot_pending ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','claimed','done','failed','interrupted','unknown','cancelled'));
      ALTER TABLE bot_pending ADD COLUMN run_id TEXT REFERENCES bot_runs(id);
      CREATE TABLE bot_run_inputs(run_id TEXT NOT NULL REFERENCES bot_runs(id), position INTEGER NOT NULL,
        chat_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(run_id,position));
      CREATE TABLE bot_model_changes(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
        selection_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('applying','applied','failed','unknown')),
        created_at INTEGER NOT NULL, ended_at INTEGER);
      PRAGMA user_version=6;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
