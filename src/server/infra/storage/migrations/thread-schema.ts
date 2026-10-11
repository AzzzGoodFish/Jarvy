import type { DatabaseSync } from "node:sqlite";

/** v13 (A37 P2): a channel message can be a copy of a thread reply ("同时发到频道"), or a
 * thread's conclusion; `echo_of` points at that thread. Threads themselves use the v12 chat columns. Additive only. */
export function migrateThreads(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 13) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE messages ADD COLUMN echo_of TEXT REFERENCES chats(id) ON DELETE SET NULL;
      PRAGMA user_version=13;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
