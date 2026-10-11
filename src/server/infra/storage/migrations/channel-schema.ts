import type { DatabaseSync } from "node:sqlite";

/** v12 (A37): sections, channel fields (section, topic, notice), thread links for P2,
 * one read position per member per Chat, mentions resolved at send time, and globally unique member names.
 * Additive only. Existing members start "read up to now", so the upgrade shows no backlog of unread. */
export function migrateChannels(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 12) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE sections(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL,
        position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      ALTER TABLE chats ADD COLUMN section_id TEXT REFERENCES sections(id) ON DELETE SET NULL;
      ALTER TABLE chats ADD COLUMN topic TEXT NOT NULL DEFAULT '';
      ALTER TABLE chats ADD COLUMN parent_id TEXT REFERENCES chats(id) ON DELETE CASCADE;
      ALTER TABLE chats ADD COLUMN root_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE;
      ALTER TABLE chats ADD COLUMN status TEXT CHECK(status IS NULL OR status IN ('open','done'));
      CREATE UNIQUE INDEX chat_thread_root ON chats(root_message_id) WHERE root_message_id IS NOT NULL;
      CREATE INDEX chat_children ON chats(parent_id) WHERE parent_id IS NOT NULL;
      CREATE TABLE chat_notes(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, text TEXT NOT NULL,
        updated_by TEXT NOT NULL REFERENCES members(id), updated_at INTEGER NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE chat_states(chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES members(id),
        read_sequence INTEGER NOT NULL DEFAULT 0, following INTEGER NOT NULL DEFAULT 0 CHECK(following IN (0,1)),
        note_seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat_id, member_id));
      CREATE TABLE message_mentions(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id), PRIMARY KEY(message_id, member_id));
      CREATE INDEX message_mentions_by_member ON message_mentions(member_id, message_id);
      INSERT INTO chat_states(chat_id, member_id, read_sequence)
        SELECT cm.chat_id, cm.member_id, COALESCE((SELECT MAX(sequence) FROM messages m WHERE m.chat_id=cm.chat_id), 0) FROM chat_members cm;
    `);
    // @ is resolved from message text by name, so names must be unambiguous. The login name
    // is kept as is; Bots lose "@" and later duplicates (case-insensitive) get " 2", " 3", ...
    const taken = new Set((db.prepare("SELECT username FROM account").all() as { username: string }[]).map(row => row.username.toLowerCase()));
    const rename = db.prepare("UPDATE bots SET name=? WHERE id=?");
    for (const bot of db.prepare("SELECT id,name FROM bots ORDER BY created_at,id").all() as { id: string; name: string }[]) {
      const base = bot.name.replace(/@/g, "").trim() || "Bot";
      let name = base;
      for (let suffix = 2; taken.has(name.toLowerCase()); suffix++) name = `${base} ${suffix}`;
      taken.add(name.toLowerCase());
      if (name !== bot.name) rename.run(name, bot.id);
    }
    db.exec("PRAGMA user_version=12; COMMIT;");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
