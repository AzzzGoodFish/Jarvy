import type { DatabaseSync } from "node:sqlite";

/** v11 (A36): a message may carry a Bot's question card — its options, state and
 * answer — as JSON. The answer stays on the question; it is not a new user message. */
export function migrateQuestions(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 11) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE messages ADD COLUMN question TEXT; PRAGMA user_version=11; COMMIT;");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
