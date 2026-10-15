import type { DatabaseSync } from "node:sqlite";

/** v20 (A50): work environments. `environments` holds places a Bot's tools can run, each belonging to a person:
 * `host` (the owner's computer, made when first needed) and `computer` (a Bot's own container; `connection` names
 * it). `environment_grants` says which Bots may use someone's environment. A Bot's `home_environment_id` is its
 * default and `current_environment_id` where it works now; NULL means the owner's computer, which is where every
 * Bot from before stays. Downgrading needs a v19 backup and matching program. */
export function migrateEnvironments(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 20) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE environments(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('host','computer')), name TEXT NOT NULL DEFAULT '',
        connection TEXT NOT NULL DEFAULT '{}', directory TEXT, bot_id TEXT REFERENCES bots(id),
        created_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE UNIQUE INDEX environments_host ON environments(owner_id) WHERE kind='host' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX environments_computer ON environments(bot_id) WHERE kind='computer' AND deleted_at IS NULL;
      CREATE TABLE environment_grants(environment_id TEXT NOT NULL REFERENCES environments(id),
        bot_id TEXT NOT NULL REFERENCES bots(id), granted_by TEXT NOT NULL REFERENCES members(id),
        granted_at INTEGER NOT NULL, PRIMARY KEY(environment_id, bot_id));
      ALTER TABLE bots ADD COLUMN home_environment_id TEXT REFERENCES environments(id);
      ALTER TABLE bots ADD COLUMN current_environment_id TEXT REFERENCES environments(id);
      PRAGMA user_version=20;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
