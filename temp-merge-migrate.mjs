// migrate-host.ts
import { DatabaseSync } from "node:sqlite";

// ../../jarvy/src/server/infra/storage/migrations/composition-schema.ts
function migrateComposition(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 7) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`ALTER TABLE messages ADD COLUMN history_id INTEGER;
      ALTER TABLE messages ADD COLUMN tool_call_id TEXT;
      ALTER TABLE chat_members ADD COLUMN can_read INTEGER NOT NULL DEFAULT 1 CHECK(can_read IN (0,1));
      PRAGMA user_version=7; COMMIT;`);
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/installation-schema.ts
function migrateInstallation(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 8) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`CREATE TABLE installation (
      id INTEGER PRIMARY KEY CHECK(id=1), device_id TEXT NOT NULL
    ); PRAGMA user_version=8; COMMIT;`);
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/message-id-schema.ts
function migrateMessageIds(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 9) return;
  db2.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db2.exec(`
      CREATE TEMP TABLE message_ids(old TEXT PRIMARY KEY, new TEXT NOT NULL);
      INSERT INTO message_ids SELECT id,'m'||position FROM messages;
      UPDATE attachments SET message_id=(SELECT new FROM message_ids WHERE old=message_id) WHERE message_id IS NOT NULL;
      UPDATE bot_pending SET message_id=(SELECT new FROM message_ids WHERE old=message_id);
      UPDATE bot_run_inputs SET message_id=(SELECT new FROM message_ids WHERE old=message_id) WHERE message_id IN (SELECT old FROM message_ids);
      UPDATE messages SET id='m'||position;
      DROP TABLE message_ids;
      PRAGMA user_version=9;
    `);
    if (db2.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  } finally {
    db2.exec("PRAGMA foreign_keys=ON");
  }
}

// ../../jarvy/src/server/infra/storage/migrations/appearance-schema.ts
import { randomInt } from "node:crypto";

// ../../jarvy/src/contract/models.ts
var BOT_COLORS = ["gray", "blue", "green", "amber", "rose", "violet"];

// ../../jarvy/src/server/infra/storage/migrations/appearance-schema.ts
function migrateAppearance(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 10) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`ALTER TABLE bots ADD COLUMN color TEXT NOT NULL DEFAULT 'gray';
      ALTER TABLE bots ADD COLUMN mood TEXT NOT NULL DEFAULT 'normal';`);
    const recolor = db2.prepare("UPDATE bots SET color=? WHERE id=?");
    for (const { id } of db2.prepare("SELECT id FROM bots").all()) recolor.run(BOT_COLORS[randomInt(BOT_COLORS.length)], id);
    db2.exec(`ALTER TABLE bots DROP COLUMN avatar_mime;
      ALTER TABLE bots DROP COLUMN avatar_data;
      ALTER TABLE bots DROP COLUMN avatar_updated_at;
      PRAGMA user_version=10; COMMIT;`);
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/question-schema.ts
function migrateQuestions(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 11) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec("ALTER TABLE messages ADD COLUMN question TEXT; PRAGMA user_version=11; COMMIT;");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/channel-schema.ts
function migrateChannels(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 12) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
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
    const taken = new Set(db2.prepare("SELECT username FROM account").all().map((row) => row.username.toLowerCase()));
    const rename = db2.prepare("UPDATE bots SET name=? WHERE id=?");
    for (const bot of db2.prepare("SELECT id,name FROM bots ORDER BY created_at,id").all()) {
      const base = bot.name.replace(/@/g, "").trim() || "Bot";
      let name = base;
      for (let suffix = 2; taken.has(name.toLowerCase()); suffix++) name = `${base} ${suffix}`;
      taken.add(name.toLowerCase());
      if (name !== bot.name) rename.run(name, bot.id);
    }
    db2.exec("PRAGMA user_version=12; COMMIT;");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/thread-schema.ts
function migrateThreads(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 13) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
      ALTER TABLE messages ADD COLUMN echo_of TEXT REFERENCES chats(id) ON DELETE SET NULL;
      PRAGMA user_version=13;
    `);
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/subscription-schema.ts
function migrateSubscriptions(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 14) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
      ALTER TABLE chat_states ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 0 CHECK(subscribed IN (0,1));
      PRAGMA user_version=14;
    `);
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/interaction-schema.ts
function migrateInteractions(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 15) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
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
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/inbox-schema.ts
function migrateInbox(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 16) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
      CREATE TABLE inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('message','reaction','note')), reason TEXT NOT NULL,
        urgency TEXT NOT NULL CHECK(urgency IN ('interrupt','queue','digest')),
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES members(id), detail TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','told','done','failed','interrupted','unknown','cancelled')),
        run_id TEXT REFERENCES bot_runs(id), created_at INTEGER NOT NULL, told_at INTEGER);
      CREATE UNIQUE INDEX inbox_one_message ON inbox(member_id, message_id) WHERE kind='message';
      CREATE INDEX inbox_open ON inbox(member_id, state, id);
      CREATE INDEX inbox_run ON inbox(run_id) WHERE run_id IS NOT NULL;
      INSERT INTO inbox(member_id,kind,reason,urgency,chat_id,message_id,actor_id,state,run_id,created_at)
        SELECT p.bot_id,'message',CASE c.type WHEN 'dm' THEN 'dm' ELSE 'mention' END,'interrupt',m.chat_id,p.message_id,m.sender_id,p.state,p.run_id,p.created_at
        FROM bot_pending p JOIN messages m ON m.id=p.message_id JOIN chats c ON c.id=m.chat_id ORDER BY p.arrival_sequence;
      INSERT INTO inbox(member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,state,created_at,told_at)
        SELECT bot_id,'reaction','author','queue',chat_id,message_id,actor_id,emoji,CASE WHEN told_at IS NULL THEN 'pending' ELSE 'told' END,created_at,told_at
        FROM bot_notices ORDER BY id;
      ALTER TABLE chat_states ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1));
      DROP TABLE bot_pending;
      DROP TABLE bot_notices;
      PRAGMA user_version=16;
    `);
    if (db2.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/quote-schema.ts
function migrateQuotes(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 17) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
      CREATE TABLE message_quotes(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 1), source_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        source_sender_id TEXT NOT NULL REFERENCES members(id), text TEXT NOT NULL, PRIMARY KEY(message_id, position));
      CREATE INDEX message_quotes_by_source ON message_quotes(source_id);
      PRAGMA user_version=17;
    `);
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/title-schema.ts
function migrateTitles(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 18) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`UPDATE chats SET title='' WHERE type='dm' AND title='\u65B0\u5BF9\u8BDD' AND NOT EXISTS(SELECT 1 FROM messages WHERE chat_id=chats.id);
      PRAGMA user_version=18;`);
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/shared/models.ts
var AGENT_BOT_ID = "00000000-0000-4000-8000-000000000001";

// ../../jarvy/src/server/infra/storage/migrations/agent-schema.ts
function migrateAgent(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 19) return;
  db2.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    const sequence = db2.prepare("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get()?.seq ?? 0;
    db2.exec(`
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE inbox_next(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('message','reaction','note','onboard','change')), reason TEXT NOT NULL,
        urgency TEXT NOT NULL CHECK(urgency IN ('interrupt','queue','digest')),
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES members(id), detail TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','told','done','failed','interrupted','unknown','cancelled')),
        run_id TEXT REFERENCES bot_runs(id), created_at INTEGER NOT NULL, told_at INTEGER);
      INSERT INTO inbox_next(id,member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,state,run_id,created_at,told_at)
        SELECT id,member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,state,run_id,created_at,told_at FROM inbox ORDER BY id;
      DROP TABLE inbox;
      ALTER TABLE inbox_next RENAME TO inbox;
      CREATE UNIQUE INDEX inbox_one_message ON inbox(member_id, message_id) WHERE kind='message';
      CREATE INDEX inbox_open ON inbox(member_id, state, id);
      CREATE INDEX inbox_run ON inbox(run_id) WHERE run_id IS NOT NULL;
    `);
    db2.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='inbox'").run(sequence);
    db2.prepare(`INSERT INTO settings(key,value) SELECT 'agent_onboarded',? FROM bots
      WHERE id=? AND deleted_at IS NULL AND connection_id IS NOT NULL`).run(String(Date.now()), AGENT_BOT_ID);
    db2.exec("PRAGMA user_version=19");
    if (db2.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  } finally {
    db2.exec("PRAGMA foreign_keys=ON");
  }
}

// ../../jarvy/src/server/infra/storage/migrations/environment-schema.ts
function migrateEnvironments(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 20) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
      CREATE TABLE environments(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('host','computer')), name TEXT NOT NULL DEFAULT '',
        connection TEXT NOT NULL DEFAULT '{}', directory TEXT, bot_id TEXT REFERENCES bots(id),
        created_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE UNIQUE INDEX environments_host ON environments(owner_id) WHERE kind='host' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX environments_computer ON environments(bot_id) WHERE kind='computer' AND deleted_at IS NULL;
      CREATE TABLE environment_grants(environment_id TEXT NOT NULL REFERENCES environments(id),
        bot_id TEXT NOT NULL REFERENCES bots(id), granted_by TEXT NOT NULL REFERENCES members(id),
        granted_at INTEGER NOT NULL, PRIMARY KEY(environment_id, bot_id));
      ALTER TABLE bots ADD COLUMN home_environment_id TEXT REFERENCES environments(id);
      ALTER TABLE bots ADD COLUMN current_environment_id TEXT REFERENCES environments(id);
      PRAGMA user_version=20;
    `);
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/vault/cipher.ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
var PREFIX = "enc:v1:";
var Cipher = class _Cipher {
  constructor(load, log = console.log) {
    this.load = load;
    this.log = log;
  }
  loaded = null;
  get master() {
    if (!this.loaded) {
      this.loaded = this.load();
      if (this.loaded.created) this.log(`[vault] made a new master key at ${this.loaded.location}; back it up with the data directory`);
    }
    return this.loaded;
  }
  location() {
    return this.master.location;
  }
  static sealed(text) {
    return text.startsWith(PREFIX);
  }
  seal(plain, context) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.master.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
  }
  /** The plain text, or null when it does not open under this key (another installation's key, or damaged). */
  open(sealed, context) {
    if (!_Cipher.sealed(sealed)) return null;
    try {
      const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.master.key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
  /** A short keyed fingerprint for people and logs: it tells values apart without letting anyone test guesses. */
  fingerprint(plain) {
    return createHmac("sha256", this.master.key).update(plain).digest("hex").slice(0, 8);
  }
};

// ../../jarvy/src/server/infra/storage/migrations/secret-schema.ts
function migrateSecrets(db2, cipher) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 21) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
      CREATE TABLE secrets(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id), name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('value','ssh_key')), bot_id TEXT REFERENCES bots(id),
        description TEXT NOT NULL DEFAULT '', value TEXT NOT NULL, fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX secrets_name ON secrets(owner_id, name) WHERE kind='value';
      CREATE UNIQUE INDEX secrets_bot_key ON secrets(bot_id) WHERE kind='ssh_key';
      CREATE TABLE secret_grants(secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id), scope TEXT NOT NULL CHECK(scope IN ('always','once')), run_id TEXT,
        granted_by TEXT NOT NULL REFERENCES members(id), granted_at INTEGER NOT NULL, PRIMARY KEY(secret_id, bot_id));
      CREATE TABLE secret_uses(id INTEGER PRIMARY KEY AUTOINCREMENT, secret_id TEXT REFERENCES secrets(id) ON DELETE SET NULL,
        secret_name TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id), at INTEGER NOT NULL,
        how TEXT NOT NULL CHECK(how IN ('command','ssh_sign')), environment_id TEXT, history_id INTEGER, tool_call_id TEXT,
        detail TEXT NOT NULL DEFAULT '');
      CREATE INDEX secret_uses_secret ON secret_uses(secret_id, at);
    `);
    const rows = db2.prepare("SELECT connection_id AS id, credential_json AS json FROM provider_credentials").all();
    const update = db2.prepare("UPDATE provider_credentials SET credential_json=? WHERE connection_id=?");
    for (const row of rows) if (!Cipher.sealed(row.json)) update.run(cipher.seal(row.json, `credential:${row.id}`), row.id);
    db2.exec("PRAGMA user_version=21");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/ssh-schema.ts
function migrateSsh(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 22) return;
  db2.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db2.exec(`
      CREATE TABLE environments_next(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('host','computer','ssh')), name TEXT NOT NULL DEFAULT '',
        connection TEXT NOT NULL DEFAULT '{}', directory TEXT, bot_id TEXT REFERENCES bots(id),
        key TEXT, host_keys TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER);
      INSERT INTO environments_next(id,owner_id,kind,name,connection,directory,bot_id,created_at,deleted_at)
        SELECT id,owner_id,kind,name,connection,directory,bot_id,created_at,deleted_at FROM environments;
      DROP TABLE environments;
      ALTER TABLE environments_next RENAME TO environments;
      CREATE UNIQUE INDEX environments_host ON environments(owner_id) WHERE kind='host' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX environments_computer ON environments(bot_id) WHERE kind='computer' AND deleted_at IS NULL;
      PRAGMA user_version=22;
    `);
    if (db2.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  } finally {
    db2.exec("PRAGMA foreign_keys=ON");
  }
}

// ../../jarvy/src/server/infra/storage/migrations/task-schema.ts
function migrateTasks(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 23) return;
  db2.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    const sequence = db2.prepare("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get()?.seq ?? 0;
    db2.exec(`
      CREATE TABLE tasks(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        name TEXT NOT NULL, instruction TEXT NOT NULL,
        schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('once','every','daily','weekly')),
        schedule_at INTEGER, schedule_minutes INTEGER, schedule_hour INTEGER, schedule_minute INTEGER, schedule_weekday INTEGER,
        state TEXT NOT NULL CHECK(state IN ('active','paused','done')),
        next_run_at INTEGER, last_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE INDEX tasks_due ON tasks(state, next_run_at) WHERE deleted_at IS NULL;
      CREATE INDEX tasks_bot ON tasks(bot_id) WHERE deleted_at IS NULL;
      CREATE TABLE inbox_next(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('message','reaction','note','onboard','change','task')), reason TEXT NOT NULL,
        urgency TEXT NOT NULL CHECK(urgency IN ('interrupt','queue','digest')),
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES members(id), detail TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','told','done','failed','interrupted','unknown','cancelled')),
        run_id TEXT REFERENCES bot_runs(id), created_at INTEGER NOT NULL, told_at INTEGER);
      INSERT INTO inbox_next(id,member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,state,run_id,created_at,told_at)
        SELECT id,member_id,kind,reason,urgency,chat_id,message_id,actor_id,detail,state,run_id,created_at,told_at FROM inbox ORDER BY id;
      DROP TABLE inbox;
      ALTER TABLE inbox_next RENAME TO inbox;
      CREATE UNIQUE INDEX inbox_one_message ON inbox(member_id, message_id) WHERE kind='message';
      CREATE INDEX inbox_open ON inbox(member_id, state, id);
      CREATE INDEX inbox_run ON inbox(run_id) WHERE run_id IS NOT NULL;
    `);
    db2.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='inbox'").run(sequence);
    db2.exec("PRAGMA user_version=23");
    if (db2.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  } finally {
    db2.exec("PRAGMA foreign_keys=ON");
  }
}

// ../../jarvy/src/server/infra/storage/migrations/ssh-login-schema.ts
function migrateSshLogin(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 24) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec("ALTER TABLE environments ADD COLUMN password TEXT; PRAGMA user_version=24");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/fold-schema.ts
function migrateFolds(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 25) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec("ALTER TABLE messages ADD COLUMN folded_at INTEGER; PRAGMA user_version=25;");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/transaction.ts
function transaction(db2, work) {
  db2.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db2.exec("COMMIT");
    return result;
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}
function migration(db2, version, work, { rebuild = false } = {}) {
  if (userVersion(db2) >= version) return;
  if (rebuild) db2.exec("PRAGMA foreign_keys=OFF");
  try {
    transaction(db2, () => {
      work();
      if (rebuild && db2.prepare("PRAGMA foreign_key_check").get()) throw new Error("Migration has invalid references");
      db2.exec(`PRAGMA user_version=${version}`);
    });
  } finally {
    if (rebuild) db2.exec("PRAGMA foreign_keys=ON");
  }
}
var userVersion = (db2) => db2.prepare("PRAGMA user_version").get().user_version;

// ../../jarvy/src/server/infra/storage/migrations/delivery-schema.ts
function migrateDeliveries(db2) {
  migration(db2, 26, () => {
    const sequence = db2.prepare("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get()?.seq ?? 0;
    db2.exec(`
      CREATE TABLE inbox_next(id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id),
        category TEXT NOT NULL CHECK(category IN ('message','activity','system')), kind TEXT NOT NULL, reason TEXT NOT NULL,
        urgency TEXT NOT NULL CHECK(urgency IN ('interrupt','queue','digest')),
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES members(id), payload TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','told','done','failed','interrupted','unknown','cancelled')),
        run_id TEXT REFERENCES bot_runs(id), created_at INTEGER NOT NULL, told_at INTEGER,
        CHECK(category='system' OR chat_id IS NOT NULL),
        CHECK(category<>'system' OR (chat_id IS NULL AND message_id IS NULL)),
        CHECK(category<>'message' OR message_id IS NOT NULL));
      INSERT INTO inbox_next(id,member_id,category,kind,reason,urgency,chat_id,message_id,actor_id,payload,state,run_id,created_at,told_at)
        SELECT id,member_id,
          CASE WHEN kind='message' THEN 'message' WHEN kind IN ('reaction','note') THEN 'activity' ELSE 'system' END,
          kind,reason,urgency,
          CASE WHEN kind IN ('onboard','change','task') THEN NULL ELSE chat_id END,
          CASE WHEN kind IN ('onboard','change','task') THEN NULL ELSE message_id END,
          actor_id,
          CASE kind WHEN 'reaction' THEN json_object('emoji',detail) WHEN 'note' THEN json_object('version',CAST(detail AS INTEGER))
            WHEN 'onboard' THEN json_object('language',detail) ELSE detail END,
          state,run_id,created_at,told_at FROM inbox ORDER BY id;
      DROP TABLE inbox;
      ALTER TABLE inbox_next RENAME TO inbox;
      CREATE UNIQUE INDEX inbox_one_message ON inbox(member_id, message_id) WHERE category='message';
      CREATE INDEX inbox_open ON inbox(member_id, state, id);
      CREATE INDEX inbox_run ON inbox(run_id) WHERE run_id IS NOT NULL;
    `);
    db2.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='inbox'").run(sequence);
  }, { rebuild: true });
}

// ../../jarvy/src/server/infra/storage/migrations/machine-description-schema.ts
function migrateMachineDescriptions(db2) {
  migration(db2, 27, () => db2.exec("ALTER TABLE environments ADD COLUMN description TEXT NOT NULL DEFAULT ''"));
}

// ../../jarvy/src/server/infra/storage/migrations/attachment-file-schema.ts
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";

// ../../jarvy/src/server/infra/files/attachments.ts
import { dirname, join } from "node:path";

// ../../jarvy/src/server/infra/files/thumbnails.ts
import sharp from "sharp";
var SMALL = 300 * 1024;

// ../../jarvy/src/server/infra/files/attachments.ts
var attachmentPath = (root, id) => join(root, id.slice(0, 2), id);

// ../../jarvy/src/server/infra/storage/migrations/attachment-file-schema.ts
function migrateAttachmentFiles(db2, dataDir) {
  if (userVersion(db2) >= 28) return;
  const root = join2(dataDir, "attachments");
  const rows = db2.prepare("SELECT id,size,data FROM attachments").iterate();
  for (const row of rows) writeOut(attachmentPath(root, row.id), row.data);
  migration(db2, 28, () => {
    for (const { id, size } of db2.prepare("SELECT id,size FROM attachments").all()) {
      if (sizeOf(attachmentPath(root, id)) !== size) throw new Error(`Attachment ${id} was not written out`);
    }
    db2.exec(`ALTER TABLE attachments DROP COLUMN data;
      CREATE TABLE attachment_removals(id TEXT PRIMARY KEY);
      CREATE TRIGGER attachment_removed AFTER DELETE ON attachments BEGIN INSERT OR IGNORE INTO attachment_removals(id) VALUES(old.id); END;`);
  });
  db2.exec("VACUUM");
}
function writeOut(path, data) {
  if (sizeOf(path) === data.length) return;
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const temp = `${path}.migrating`, fd = openSync(temp, "w", 384);
  try {
    for (let written = 0; written < data.length; ) written += writeSync(fd, data, written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/own-computer-schema.ts
import { createHash, randomUUID } from "node:crypto";
function migrateOwnComputers(db2, dataDir) {
  const tag = createHash("sha256").update(dataDir).digest("hex").slice(0, 6);
  migration(db2, 29, () => {
    const owner = db2.prepare("SELECT member_id AS id FROM account").get()?.id;
    if (!owner) return;
    const bots = db2.prepare("SELECT b.id, b.home_environment_id AS home, e.kind AS homeKind FROM bots b LEFT JOIN environments e ON e.id=b.home_environment_id WHERE b.deleted_at IS NULL").all();
    const now = Date.now();
    for (const bot of bots) {
      if (bot.homeKind === "computer") continue;
      const existing = db2.prepare("SELECT id FROM environments WHERE bot_id=? AND kind='computer' AND deleted_at IS NULL").get(bot.id);
      const id = existing?.id ?? randomUUID();
      if (!existing) db2.prepare("INSERT INTO environments(id,owner_id,kind,connection,directory,bot_id,created_at) VALUES(?,?,'computer',?,'/workspace',?,?)").run(id, owner, JSON.stringify({ container: `jarvy-${tag}-${bot.id.slice(0, 8)}` }), bot.id, now);
      db2.prepare("UPDATE bots SET home_environment_id=?, current_environment_id=? WHERE id=?").run(id, id, bot.id);
    }
    const hosts = db2.prepare("SELECT id FROM environments WHERE kind='host' AND deleted_at IS NULL").all().map((row) => row.id);
    for (const host of hosts) {
      db2.prepare("UPDATE bots SET current_environment_id=home_environment_id WHERE current_environment_id=?").run(host);
      db2.prepare("DELETE FROM environment_grants WHERE environment_id=?").run(host);
      db2.prepare("UPDATE environments SET deleted_at=? WHERE id=?").run(now, host);
    }
  });
}

// ../../jarvy/src/server/infra/storage/migrations/published-port-schema.ts
function migratePublishedPorts(db2) {
  migration(db2, 30, () => {
    db2.exec(`
      CREATE TABLE published_ports(bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535), name TEXT NOT NULL, description TEXT NOT NULL,
        host_port INTEGER NOT NULL UNIQUE CHECK(host_port BETWEEN 1 AND 65535),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id, port));
    `);
  });
}

// ../../jarvy/src/server/infra/storage/migrations/channel-admin-schema.ts
function migrateChannelAdmins(db2) {
  migration(db2, 31, () => {
    db2.exec(`
      ALTER TABLE chats ADD COLUMN created_by TEXT REFERENCES members(id);
      UPDATE chats SET created_by=owner_id WHERE type='channel';
      ALTER TABLE chat_members ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK(admin IN (0,1));
    `);
  });
}

// ../../jarvy/src/server/infra/storage/migrations/oversight-schema.ts
function migrateOversight(db2) {
  migration(db2, 32, () => {
    db2.exec(`
      CREATE TABLE agent_actions(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(id), at INTEGER NOT NULL,
        tool TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT 'done');
      CREATE INDEX agent_actions_bot ON agent_actions(bot_id, id);
      ALTER TABLE environment_grants ADD COLUMN run_id TEXT;
    `);
  });
}

// ../../jarvy/src/server/infra/storage/migrations/device-schema.ts
function migrateDevices(db2) {
  migration(db2, 33, () => {
    db2.exec(`
      CREATE TABLE environments_next(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('host','computer','ssh','device')), name TEXT NOT NULL DEFAULT '',
        connection TEXT NOT NULL DEFAULT '{}', directory TEXT, bot_id TEXT REFERENCES bots(id),
        key TEXT, host_keys TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER, password TEXT, description TEXT NOT NULL DEFAULT '',
        token_hash TEXT);
      INSERT INTO environments_next(id,owner_id,kind,name,connection,directory,bot_id,key,host_keys,created_at,deleted_at,password,description)
        SELECT id,owner_id,kind,name,connection,directory,bot_id,key,host_keys,created_at,deleted_at,password,description FROM environments;
      DROP TABLE environments;
      ALTER TABLE environments_next RENAME TO environments;
      CREATE UNIQUE INDEX environments_host ON environments(owner_id) WHERE kind='host' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX environments_computer ON environments(bot_id) WHERE kind='computer' AND deleted_at IS NULL;
      CREATE UNIQUE INDEX environments_device_token ON environments(token_hash) WHERE token_hash IS NOT NULL;
    `);
  }, { rebuild: true });
}

// ../../jarvy/src/server/infra/storage/migrations/schema.ts
import { randomUUID as randomUUID3 } from "node:crypto";

// ../../jarvy/src/server/infra/storage/migrations/prototype-schema.ts
import { randomUUID as randomUUID2 } from "node:crypto";
function migratePrototype(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 4) return;
  if (version === 0) {
    db2.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE account (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE,
          password_salt TEXT NOT NULL, password_hash TEXT NOT NULL);
        CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE INDEX auth_expiration ON auth_sessions(expires_at);
        CREATE TABLE bot_settings (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL, system_prompt TEXT NOT NULL);
        CREATE TABLE model_credentials (id INTEGER PRIMARY KEY CHECK(id=1), provider TEXT NOT NULL,
          base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL);
        CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE messages (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX chat_messages ON messages(chat_id,position);
        CREATE INDEX chat_recent ON chats(updated_at DESC);
        INSERT INTO bot_settings VALUES (1,'Jarvy','');
        INSERT INTO model_credentials VALUES (1,'openai-compatible','','','');
        PRAGMA user_version=1;
        COMMIT;
      `);
  }
  if (version <= 1) {
    db2.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
          system_prompt TEXT NOT NULL, model_id TEXT NOT NULL, avatar_mime TEXT, avatar_data BLOB,
          avatar_updated_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
        INSERT INTO bots(id,name,description,system_prompt,model_id,created_at)
          SELECT '${AGENT_BOT_ID}',name,'',system_prompt,'',0 FROM bot_settings WHERE id=1;
        ALTER TABLE chats ADD COLUMN bot_id TEXT REFERENCES bots(id);
        UPDATE chats SET bot_id='${AGENT_BOT_ID}';
        CREATE INDEX chat_by_bot ON chats(bot_id,updated_at DESC);
        CREATE TABLE attachments (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, name TEXT NOT NULL,
          mime_type TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX attachments_by_message ON attachments(message_id);
        DROP TABLE bot_settings;
        PRAGMA user_version=2;
        COMMIT;
      `);
  }
  if (version <= 2) {
    db2.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider_name TEXT NOT NULL,
          display_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('builtin','custom')),
          auth_type TEXT NOT NULL DEFAULT 'api_key' CHECK(auth_type IN ('api_key','oauth')),
          base_url TEXT NOT NULL, api TEXT NOT NULL, headers_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE provider_credentials (connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('api_key','oauth')), credential_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE connection_models (connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL, config_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(connection_id,model_id));
        ALTER TABLE bots ADD COLUMN connection_id TEXT REFERENCES provider_connections(id);
        ALTER TABLE bots ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off';
      `);
    try {
      const legacy = db2.prepare("SELECT provider,base_url AS baseUrl,model,api_key AS apiKey FROM model_credentials WHERE id=1").get();
      const botModels = db2.prepare("SELECT DISTINCT model_id AS modelId FROM bots WHERE model_id<>''").all();
      if (legacy && (legacy.baseUrl || legacy.model || legacy.apiKey || botModels.length)) {
        const id = randomUUID2(), now = Date.now();
        db2.prepare("INSERT INTO provider_connections(id,provider_name,display_name,kind,auth_type,base_url,api,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, legacy.provider || "openai-compatible", "\u65E7\u6A21\u578B\u914D\u7F6E", "custom", "api_key", legacy.baseUrl, "openai-completions", now, now);
        if (legacy.apiKey) db2.prepare("INSERT INTO provider_credentials(connection_id,type,credential_json,updated_at) VALUES(?,'api_key',?,?)").run(id, JSON.stringify({ type: "api_key", key: legacy.apiKey }), now);
        const modelIds = new Set([legacy.model, ...botModels.map((row) => row.modelId)].filter(Boolean));
        for (const modelId of modelIds) db2.prepare("INSERT INTO connection_models(connection_id,model_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, modelId, JSON.stringify({ id: modelId, name: modelId }), now, now);
        db2.prepare("UPDATE bots SET connection_id=?,model_id=CASE WHEN model_id='' THEN ? ELSE model_id END WHERE model_id<>'' OR ?<>''").run(id, legacy.model, legacy.model);
      }
      db2.exec("PRAGMA user_version=3; COMMIT");
    } catch (error) {
      db2.exec("ROLLBACK");
      throw error;
    }
  }
  if (version <= 3) {
    db2.exec("BEGIN IMMEDIATE; DROP TABLE model_credentials; PRAGMA user_version=4; COMMIT;");
  }
}

// ../../jarvy/src/server/infra/storage/migrations/runtime-schema.ts
function migrateRuntime(db2) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version >= 6) return;
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(`
      CREATE TABLE bot_sessions(bot_id TEXT PRIMARY KEY REFERENCES bots(id), file TEXT NOT NULL UNIQUE,
        runtime_session_id TEXT, persisted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE bot_runs(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
        state TEXT NOT NULL CHECK(state IN ('claimed','submitted','completed','failed','interrupted','unknown','cancelled')),
        selection_json TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER, error_code TEXT);
      CREATE INDEX bot_runs_recent ON bot_runs(bot_id,created_at DESC);
      CREATE UNIQUE INDEX bot_one_active_run ON bot_runs(bot_id) WHERE state IN ('claimed','submitted');
      ALTER TABLE bot_pending ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','claimed','done','failed','interrupted','unknown','cancelled'));
      ALTER TABLE bot_pending ADD COLUMN run_id TEXT REFERENCES bot_runs(id);
      CREATE TABLE bot_run_inputs(run_id TEXT NOT NULL REFERENCES bot_runs(id), position INTEGER NOT NULL,
        chat_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(run_id,position));
      CREATE TABLE bot_model_changes(id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
        selection_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('applying','applied','failed','unknown')),
        created_at INTEGER NOT NULL, ended_at INTEGER);
      PRAGMA user_version=6;
    `);
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// ../../jarvy/src/server/infra/storage/migrations/schema.ts
function migrateDatabase(db2, cipher, dataDir) {
  const version = db2.prepare("PRAGMA user_version").get().user_version;
  if (version > 33) throw new Error(`Unsupported database version: ${version}`);
  migratePrototype(db2);
  if (version >= 5) {
    migrateRuntime(db2);
    migrateComposition(db2);
    migrateInstallation(db2);
    migrateMessageIds(db2);
    migrateAppearance(db2);
    migrateQuestions(db2);
    migrateChannels(db2);
    migrateThreads(db2);
    migrateSubscriptions(db2);
    migrateInteractions(db2);
    migrateInbox(db2);
    migrateQuotes(db2);
    migrateTitles(db2);
    migrateAgent(db2);
    migrateEnvironments(db2);
    migrateSecrets(db2, cipher);
    migrateSsh(db2);
    migrateTasks(db2);
    migrateSshLogin(db2);
    migrateFolds(db2);
    migrateDeliveries(db2);
    migrateMachineDescriptions(db2);
    migrateAttachmentFiles(db2, dataDir);
    migrateOwnComputers(db2, dataDir);
    migratePublishedPorts(db2);
    migrateChannelAdmins(db2);
    migrateOversight(db2);
    migrateDevices(db2);
    return;
  }
  db2.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    const userId = randomUUID3();
    db2.exec(`
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
    db2.prepare("INSERT INTO members VALUES(?,'user')").run(userId);
    db2.exec("INSERT INTO members SELECT id,'bot' FROM bots");
    db2.prepare("UPDATE account SET member_id=?").run(userId);
    db2.prepare("UPDATE bots SET owner_id=?").run(userId);
    db2.prepare("UPDATE provider_connections SET owner_id=?").run(userId);
    db2.prepare("INSERT INTO chats_next SELECT id,'dm',title,?,created_at,updated_at FROM chats").run(userId);
    db2.prepare("INSERT INTO chat_members SELECT id,?,1 FROM chats").run(userId);
    db2.exec("INSERT INTO chat_members SELECT id,bot_id,1 FROM chats");
    db2.prepare(`INSERT INTO messages_next(position,id,chat_id,sequence,sender_id,content,created_at)
      SELECT m.position,m.id,m.chat_id,ROW_NUMBER() OVER (PARTITION BY m.chat_id ORDER BY m.position),
        CASE WHEN m.role='assistant' THEN c.bot_id ELSE ? END,m.content,m.created_at
      FROM messages m JOIN chats c ON c.id=m.chat_id ORDER BY m.position`).run(userId);
    db2.prepare(`INSERT INTO attachments_next SELECT a.id,a.chat_id,a.message_id,COALESCE(m.sender_id,?),
      a.name,a.mime_type,a.size,a.data,a.created_at FROM attachments a LEFT JOIN messages_next m ON m.id=a.message_id`).run(userId);
    db2.exec(`
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
    if (db2.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration has invalid references");
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  } finally {
    db2.exec("PRAGMA foreign_keys=ON");
  }
  migrateRuntime(db2);
  migrateComposition(db2);
  migrateInstallation(db2);
  migrateMessageIds(db2);
  migrateAppearance(db2);
  migrateQuestions(db2);
  migrateChannels(db2);
  migrateThreads(db2);
  migrateSubscriptions(db2);
  migrateInteractions(db2);
  migrateInbox(db2);
  migrateQuotes(db2);
  migrateTitles(db2);
  migrateAgent(db2);
  migrateEnvironments(db2);
  migrateSecrets(db2, cipher);
  migrateSsh(db2);
  migrateTasks(db2);
  migrateSshLogin(db2);
  migrateFolds(db2);
  migrateDeliveries(db2);
  migrateMachineDescriptions(db2);
  migrateAttachmentFiles(db2, dataDir);
  migrateOwnComputers(db2, dataDir);
  migratePublishedPorts(db2);
  migrateChannelAdmins(db2);
  migrateOversight(db2);
  migrateDevices(db2);
}

// migrate-host.ts
var db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA foreign_keys=ON");
migrateDatabase(db, { seal() {
  throw new Error("no cipher");
}, open() {
  throw new Error("no cipher");
} }, process.argv[3]);
var v = db.prepare("PRAGMA user_version").get().user_version;
if (v !== 33) throw new Error(`lhy at v${v}`);
console.log(`lhy migrated to v${v}`);
