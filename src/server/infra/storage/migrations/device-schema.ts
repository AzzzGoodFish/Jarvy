import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v33 (A96): computers that connect themselves to Jarvy through the desktop client. `environments.kind` gains
 * `device`, which SQLite can only take by rebuilding the table with its rows and indexes; `token_hash` is the SHA-256
 * of the computer's own token, the only way it signs in, never the token itself. A device's `connection` holds what
 * it last reported (system, architecture, home, shells, client version) and the owner's choice of shell. Downgrading
 * needs a v32 backup and matching program. */
export function migrateDevices(db: DatabaseSync): void {
  migration(db, 33, () => {
    db.exec(`
      CREATE TABLE environments_next(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('host','computer','ssh','device')), name TEXT NOT NULL DEFAULT '',
        connection TEXT NOT NULL DEFAULT '{}', directory TEXT, bot_id TEXT REFERENCES bots(id),
        key TEXT, host_keys TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER, password TEXT, description TEXT NOT NULL DEFAULT '',
        token_hash TEXT);
      INSERT INTO environments_next(id,owner_id,kind,name,connection,directory,bot_id,key,host_keys,created_at,deleted_at,password,description)
        SELECT id,owner_id,kind,name,connection,directory,bot_id,key,host_keys,created_at,deleted_at,password,description FROM environments;
      DROP TABLE environments;
      ALTER TABLE environments_next RENAME TO environments;
      CREATE UNIQUE INDEX environments_host ON environments(owner_id) WHERE kind='host' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX environments_computer ON environments(bot_id) WHERE kind='computer' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX environments_device_token ON environments(token_hash) WHERE token_hash IS NOT NULL;
    `);
  }, { rebuild: true });
}
