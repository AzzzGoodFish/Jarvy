import type { DatabaseSync } from "node:sqlite";

/** v25 (A60): a message the owner folded keeps its content and shows as one line in the interface. `folded_at` is
 * when it was folded, null when it is not; only the interface reads it, a Bot never does. */
export function migrateFolds(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 25) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE messages ADD COLUMN folded_at INTEGER; PRAGMA user_version=25;");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
