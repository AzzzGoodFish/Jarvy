import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AGENT_BOT_ID as DEFAULT_BOT_ID } from "../../../shared/models.js";

/** Sequential migrations of the persisted v1-v4 public data contract. */
export function migratePrototype(db: DatabaseSync): void {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version >= 4) return;
    if (version === 0) {
      db.exec(`
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
      // Keep existing accounts, chats and messages; turn the old single bot into
      // the first bot and attach every existing chat to it.
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
          system_prompt TEXT NOT NULL, model_id TEXT NOT NULL, avatar_mime TEXT, avatar_data BLOB,
          avatar_updated_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
        INSERT INTO bots(id,name,description,system_prompt,model_id,created_at)
          SELECT '${DEFAULT_BOT_ID}',name,'',system_prompt,'',0 FROM bot_settings WHERE id=1;
        ALTER TABLE chats ADD COLUMN bot_id TEXT REFERENCES bots(id);
        UPDATE chats SET bot_id='${DEFAULT_BOT_ID}';
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
      db.exec(`
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
      const legacy = db.prepare("SELECT provider,base_url AS baseUrl,model,api_key AS apiKey FROM model_credentials WHERE id=1")
        .get() as { provider: string; baseUrl: string; model: string; apiKey: string } | undefined;
      const botModels = db.prepare("SELECT DISTINCT model_id AS modelId FROM bots WHERE model_id<>''")
        .all() as { modelId: string }[];
      if (legacy && (legacy.baseUrl || legacy.model || legacy.apiKey || botModels.length)) {
        const id = randomUUID(), now = Date.now();
          db.prepare("INSERT INTO provider_connections(id,provider_name,display_name,kind,auth_type,base_url,api,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(id, legacy.provider || "openai-compatible", "旧模型配置", "custom", "api_key", legacy.baseUrl, "openai-completions", now, now);
          if (legacy.apiKey) db.prepare("INSERT INTO provider_credentials(connection_id,type,credential_json,updated_at) VALUES(?,'api_key',?,?)")
            .run(id, JSON.stringify({ type: "api_key", key: legacy.apiKey }), now);
          const modelIds = new Set([legacy.model, ...botModels.map(row => row.modelId)].filter(Boolean));
          for (const modelId of modelIds) db.prepare("INSERT INTO connection_models(connection_id,model_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?)")
            .run(id, modelId, JSON.stringify({ id: modelId, name: modelId }), now, now);
          db.prepare("UPDATE bots SET connection_id=?,model_id=CASE WHEN model_id='' THEN ? ELSE model_id END WHERE model_id<>'' OR ?<>''")
            .run(id, legacy.model, legacy.model);
      }
      db.exec("PRAGMA user_version=3; COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version <= 3) {
      // The v3 catalog replaced the legacy global key. Remove that second
      // writable copy only after v1/v2 data has been migrated to its connection.
      db.exec("BEGIN IMMEDIATE; DROP TABLE model_credentials; PRAGMA user_version=4; COMMIT;");
    }
}
