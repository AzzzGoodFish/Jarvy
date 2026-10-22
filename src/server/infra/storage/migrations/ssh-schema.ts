import type { DatabaseSync } from "node:sqlite";

/** v22 (A57): machines the owner adds over SSH. `environments.kind` gains `ssh`; SQLite can't change a CHECK in place,
 * so the table is rebuilt with its rows and indexes (the tables that refer to it keep their references). An SSH
 * machine's `connection` holds its host, port, user, home and system, `directory` where tools start, `key` the
 * private key Jarvy made for it, sealed with the master key, and `host_keys` the host keys the owner accepted with
 * their fingerprints. Downgrading needs a v21 backup and matching program. */
export function migrateSsh(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 22) return;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE environments_next(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('host','computer','ssh')), name TEXT NOT NULL DEFAULT '',
        connection TEXT NOT NULL DEFAULT '{}', directory TEXT, bot_id TEXT REFERENCES bots(id),
        key TEXT, host_keys TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER);
      INSERT INTO environments_next(id,owner_id,kind,name,connection,directory,bot_id,created_at,deleted_at)
        SELECT id,owner_id,kind,name,connection,directory,bot_id,created_at,deleted_at FROM environments;
      DROP TABLE environments;
      ALTER TABLE environments_next RENAME TO environments;
      CREATE UNIQUE INDEX environments_host ON environments(owner_id) WHERE kind='host' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX environments_computer ON environments(bot_id) WHERE kind='computer' AND deleted_at IS NULL;
      PRAGMA user_version=22;
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
}
