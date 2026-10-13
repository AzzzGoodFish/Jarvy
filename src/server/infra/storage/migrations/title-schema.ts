import type { DatabaseSync } from "node:sqlite";

/** v18 (A45): a DM that has no message yet is untitled. Its placeholder title was the Chinese 「新对话」, written by the
 * server; now it is the empty string, and the first message still names the DM. Only placeholders change: a chat a
 * person or a first message named keeps its title, whatever language it is in. No column changes. */
export function migrateTitles(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 18) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`UPDATE chats SET title='' WHERE type='dm' AND title='新对话' AND NOT EXISTS(SELECT 1 FROM messages WHERE chat_id=chats.id);
      PRAGMA user_version=18;`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
