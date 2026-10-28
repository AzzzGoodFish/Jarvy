import { migrateComposition } from "./composition-schema.js";
import { migrateInstallation } from "./installation-schema.js";
import { migrateMessageIds } from "./message-id-schema.js";
import { migrateAppearance } from "./appearance-schema.js";
import { migrateQuestions } from "./question-schema.js";
import { migrateChannels } from "./channel-schema.js";
import { migrateThreads } from "./thread-schema.js";
import { migrateSubscriptions } from "./subscription-schema.js";
import { migrateInteractions } from "./interaction-schema.js";
import { migrateInbox } from "./inbox-schema.js";
import { migrateQuotes } from "./quote-schema.js";
import { migrateTitles } from "./title-schema.js";
import { migrateAgent } from "./agent-schema.js";
import { migrateEnvironments } from "./environment-schema.js";
import { migrateSecrets } from "./secret-schema.js";
import { migrateSsh } from "./ssh-schema.js";
import { migrateTasks } from "./task-schema.js";
import { migrateSshLogin } from "./ssh-login-schema.js";
import { migrateFolds } from "./fold-schema.js";
import { migrateDeliveries } from "./delivery-schema.js";
import { migrateMachineDescriptions } from "./machine-description-schema.js";
import { migrateAttachmentFiles } from "./attachment-file-schema.js";
import type { Cipher } from "../../vault/cipher.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { migratePrototype } from "./prototype-schema.js";
import { migrateRuntime } from "./runtime-schema.js";

export function migrateDatabase(db: DatabaseSync, cipher: Cipher, dataDir: string): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > 28) throw new Error(`Unsupported database version: ${version}`);
  migratePrototype(db);
  if (version >= 5) { migrateRuntime(db); migrateComposition(db); migrateInstallation(db); migrateMessageIds(db); migrateAppearance(db); migrateQuestions(db); migrateChannels(db); migrateThreads(db); migrateSubscriptions(db); migrateInteractions(db); migrateInbox(db); migrateQuotes(db); migrateTitles(db); migrateAgent(db); migrateEnvironments(db); migrateSecrets(db, cipher); migrateSsh(db); migrateTasks(db); migrateSshLogin(db); migrateFolds(db); migrateDeliveries(db); migrateMachineDescriptions(db); migrateAttachmentFiles(db, dataDir); return; }
  // Rebuild the old chat tables rather than dual-writing role/bot_id alongside
  // sender identity and membership. Old messages are history, never re-enqueued.
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    const userId = randomUUID();
    db.exec(`
      CREATE TABLE members(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('user','bot')));
      ALTER TABLE account ADD COLUMN member_id TEXT REFERENCES members(id);
      ALTER TABLE bots ADD COLUMN owner_id TEXT REFERENCES members(id);
      ALTER TABLE provider_connections ADD COLUMN owner_id TEXT REFERENCES members(id);
      CREATE TABLE chats_next(id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('dm','channel','thread')),
        title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE chat_members(chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id), can_write INTEGER NOT NULL DEFAULT 1 CHECK(can_write IN (0,1)),
        PRIMARY KEY(chat_id,member_id));
      CREATE TABLE messages_next(position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
        sender_id TEXT NOT NULL REFERENCES members(id), content TEXT NOT NULL, created_at INTEGER NOT NULL,
        client_key TEXT, request_hash TEXT, UNIQUE(chat_id,sequence), UNIQUE(sender_id,client_key));
      CREATE TABLE attachments_next(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, uploaded_by TEXT NOT NULL REFERENCES members(id),
        name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
    `);
    db.prepare("INSERT INTO members VALUES(?,'user')").run(userId);
    db.exec("INSERT INTO members SELECT id,'bot' FROM bots");
    db.prepare("UPDATE account SET member_id=?").run(userId);
    db.prepare("UPDATE bots SET owner_id=?").run(userId);
    db.prepare("UPDATE provider_connections SET owner_id=?").run(userId);
    db.prepare("INSERT INTO chats_next SELECT id,'dm',title,?,created_at,updated_at FROM chats").run(userId);
    db.prepare("INSERT INTO chat_members SELECT id,?,1 FROM chats").run(userId);
    db.exec("INSERT INTO chat_members SELECT id,bot_id,1 FROM chats");
    db.prepare(`INSERT INTO messages_next(position,id,chat_id,sequence,sender_id,content,created_at)
      SELECT m.position,m.id,m.chat_id,ROW_NUMBER() OVER (PARTITION BY m.chat_id ORDER BY m.position),
        CASE WHEN m.role='assistant' THEN c.bot_id ELSE ? END,m.content,m.created_at
      FROM messages m JOIN chats c ON c.id=m.chat_id ORDER BY m.position`).run(userId);
    db.prepare(`INSERT INTO attachments_next SELECT a.id,a.chat_id,a.message_id,COALESCE(m.sender_id,?),
      a.name,a.mime_type,a.size,a.data,a.created_at FROM attachments a LEFT JOIN messages_next m ON m.id=a.message_id`).run(userId);
    db.exec(`
      DROP TABLE attachments; DROP TABLE messages; DROP TABLE chats;
      ALTER TABLE chats_next RENAME TO chats;
      ALTER TABLE messages_next RENAME TO messages;
      ALTER TABLE attachments_next RENAME TO attachments;
      CREATE INDEX chat_recent ON chats(updated_at DESC);
      CREATE INDEX chat_members_by_member ON chat_members(member_id,chat_id);
      CREATE INDEX chat_messages ON messages(chat_id,sequence);
      CREATE INDEX attachments_by_message ON attachments(message_id);
      CREATE TABLE bot_pending(arrival_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL REFERENCES members(id), message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, UNIQUE(bot_id,message_id));
      CREATE INDEX bot_pending_order ON bot_pending(bot_id,arrival_sequence);
      PRAGMA user_version=5;
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
  migrateRuntime(db);
  migrateComposition(db);
  migrateInstallation(db);
  migrateMessageIds(db);
  migrateAppearance(db);
  migrateQuestions(db);
  migrateChannels(db);
  migrateThreads(db);
  migrateSubscriptions(db);
  migrateInteractions(db);
  migrateInbox(db);
  migrateQuotes(db);
  migrateTitles(db); migrateAgent(db); migrateEnvironments(db); migrateSecrets(db, cipher); migrateSsh(db); migrateTasks(db); migrateSshLogin(db); migrateFolds(db); migrateDeliveries(db); migrateMachineDescriptions(db); migrateAttachmentFiles(db, dataDir);
}
