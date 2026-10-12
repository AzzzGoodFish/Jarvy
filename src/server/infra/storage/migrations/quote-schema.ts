import type { DatabaseSync } from "node:sqlite";

/** v17 (A44): partial quotes. A message's quotes, numbered by `position` as its `[[qN]]` marks; each keeps the source
 * message (cleared when that message goes), the source's sender and a snapshot of the quoted text. Additive only. */
export function migrateQuotes(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 17) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE message_quotes(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 1), source_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        source_sender_id TEXT NOT NULL REFERENCES members(id), text TEXT NOT NULL, PRIMARY KEY(message_id, position));
      CREATE INDEX message_quotes_by_source ON message_quotes(source_id);
      PRAGMA user_version=17;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
