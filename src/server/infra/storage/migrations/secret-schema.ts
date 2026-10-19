import type { DatabaseSync } from "node:sqlite";
import { Cipher } from "../../vault/cipher.js";

/** v21 (A52): secrets, the owner's tokens, passwords and keys. `secrets` holds each one's name, kind, description and
 * encrypted value; an SSH key belongs to one Bot. `secret_grants` says which Bots may use a secret, until revoked
 * (`always`) or for one run (`once`). `secret_uses` records every use and outlives the secret. Model credentials are
 * encrypted under the same key. Downgrading needs a v20 backup and matching program. */
export function migrateSecrets(db: DatabaseSync, cipher: Cipher): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 21) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
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
    const rows = db.prepare("SELECT connection_id AS id, credential_json AS json FROM provider_credentials").all() as { id: string; json: string }[];
    const update = db.prepare("UPDATE provider_credentials SET credential_json=? WHERE connection_id=?");
    for (const row of rows) if (!Cipher.sealed(row.json)) update.run(cipher.seal(row.json, `credential:${row.id}`), row.id);
    db.exec("PRAGMA user_version=21");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
