import type { DatabaseSync } from "node:sqlite";

/** Message IDs become `m<position>`: short in the Bot's input, never reused
 * because position is AUTOINCREMENT. Chat, member and attachment IDs stay UUIDs. Transcripts and
 * History keep the old IDs as written; no tool takes a message ID, so no old→new lookup is kept. */
export function migrateMessageIds(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 9) return;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TEMP TABLE message_ids(old TEXT PRIMARY KEY, new TEXT NOT NULL);
      INSERT INTO message_ids SELECT id,'m'||position FROM messages;
      UPDATE attachments SET message_id=(SELECT new FROM message_ids WHERE old=message_id) WHERE message_id IS NOT NULL;
      UPDATE bot_pending SET message_id=(SELECT new FROM message_ids WHERE old=message_id);
      UPDATE bot_run_inputs SET message_id=(SELECT new FROM message_ids WHERE old=message_id) WHERE message_id IN (SELECT old FROM message_ids);
      UPDATE messages SET id='m'||position;
      DROP TABLE message_ids;
      PRAGMA user_version=9;
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
}
