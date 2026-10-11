import type { DatabaseSync } from "node:sqlite";

/** v15: replies quote a message (`reply_to`, same chat), people and Bots mark messages
 * with emoji (`message_reactions`), each member pins chats in the sidebar (`chat_states.pinned`), a deleted Bot
 * keeps its member row so messages it left in channels still show who wrote them (`bots.deleted_at`), and a Bot's
 * notices — things that never start or interrupt a run, here an emoji on its message — wait in `bot_notices` (A39).
 * Additive only. */
export function migrateInteractions(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 15) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE messages ADD COLUMN reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL;
      CREATE TABLE message_reactions(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id), emoji TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(message_id, member_id, emoji));
      ALTER TABLE chat_states ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1));
      ALTER TABLE bots ADD COLUMN deleted_at INTEGER;
      CREATE TABLE bot_notices(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('reaction')), chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, actor_id TEXT NOT NULL REFERENCES members(id),
        emoji TEXT, created_at INTEGER NOT NULL, told_at INTEGER);
      CREATE INDEX bot_notices_untold ON bot_notices(bot_id, told_at);
      PRAGMA user_version=15;
    `);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
