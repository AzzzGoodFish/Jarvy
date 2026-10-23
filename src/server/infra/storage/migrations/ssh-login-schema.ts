import type { DatabaseSync } from "node:sqlite";

/** v24 (A59): an SSH machine that refuses Jarvy's key is reached with its password, which `environments.password`
 * keeps sealed with the master key (under `environment-password:<id>`); NULL means the key is used. A column added,
 * no rows rewritten. Downgrading needs a v23 backup and matching program. */
export function migrateSshLogin(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 24) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE environments ADD COLUMN password TEXT; PRAGMA user_version=24");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
