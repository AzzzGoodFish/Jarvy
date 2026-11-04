import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v30 (A74): ports Bots publish from their sandboxes. One row per Bot and sandbox port, with the Bot's name and
 * description for it and the port Jarvy took for it, which no other row has: a link sent in a chat keeps working
 * across restarts. Rows go with their Bot (deleted with it, or when its sandbox is reset). Downgrading needs a v29
 * backup and matching program. */
export function migratePublishedPorts(db: DatabaseSync): void {
  migration(db, 30, () => {
    db.exec(`
      CREATE TABLE published_ports(bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535), name TEXT NOT NULL, description TEXT NOT NULL,
        host_port INTEGER NOT NULL UNIQUE CHECK(host_port BETWEEN 1 AND 65535),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id, port));
    `);
  });
}
