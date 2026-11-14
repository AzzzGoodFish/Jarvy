import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v33 (A95): connectors, sealed connector credentials, per-Bot grants and usage logs.
 * Downgrading needs a v32 backup and matching program. */
export function migrateConnectors(db: DatabaseSync): void {
  migration(db, 33, () => {
    db.exec(`
      CREATE TABLE connectors(
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES members(id),
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('remote_mcp','builtin')),
        provider TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        safety TEXT NOT NULL DEFAULT 'confirm_writes' CHECK(safety IN ('read_only','confirm_writes','auto')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected','connected','needs_auth','error')),
        status_detail TEXT NOT NULL DEFAULT '',
        tools_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX connectors_slug ON connectors(owner_id, slug);
      CREATE TABLE connector_credentials(
        connector_id TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
        auth_type TEXT NOT NULL CHECK(auth_type IN ('none','headers','oauth')),
        credential_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE connector_grants(
        connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        granted_by TEXT NOT NULL REFERENCES members(id),
        granted_at INTEGER NOT NULL,
        PRIMARY KEY(connector_id, bot_id)
      );
      CREATE TABLE connector_uses(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL,
        connector_slug TEXT NOT NULL,
        bot_id TEXT NOT NULL REFERENCES bots(id),
        at INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('ok','error','denied')),
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX connector_uses_connector ON connector_uses(connector_id, at);
    `);
  });
}
