import type { DatabaseSync } from "node:sqlite";

/** v14: a member may subscribe to a channel or thread; then every new message there is
 * delivered to it, whether or not anyone is @-mentioned. Additive only. */
export function migrateSubscriptions(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 14) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE chat_states ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 0 CHECK(subscribed IN (0,1));
      PRAGMA user_version=14;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
