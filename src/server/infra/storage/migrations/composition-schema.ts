import type { DatabaseSync } from "node:sqlite";

export function migrateComposition(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 7) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN history_id INTEGER;
      ALTER TABLE messages ADD COLUMN tool_call_id TEXT;
      ALTER TABLE chat_members ADD COLUMN can_read INTEGER NOT NULL DEFAULT 1 CHECK(can_read IN (0,1));
      PRAGMA user_version=7; COMMIT;`);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
