import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v29 (A68): every Bot's default is its own computer, and the owner's computer is no longer an environment of its
 * own: the owner adds it as an SSH machine when Bots should work there.
 * - A Bot whose default was something else (the owner's computer) gets a computer row, named after this data directory
 *   and its own id, unless it has one, and is placed there as its default and where it is now. A Bot whose default was
 *   already its computer keeps it, and stays on the SSH machine it switched to.
 * - The owner's computer's row is deleted with its grants, and a Bot working there is back on its own computer.
 * The container is made by the program on first use: the migration only writes rows. */
export function migrateOwnComputers(db: DatabaseSync, dataDir: string): void {
  const tag = createHash("sha256").update(dataDir).digest("hex").slice(0, 6);
  migration(db, 29, () => {
    const owner = (db.prepare("SELECT member_id AS id FROM account").get() as { id: string } | undefined)?.id;
    if (!owner) return;
    const bots = db.prepare("SELECT b.id, b.home_environment_id AS home, e.kind AS homeKind FROM bots b" +
      " LEFT JOIN environments e ON e.id=b.home_environment_id WHERE b.deleted_at IS NULL").all() as { id: string; home: string | null; homeKind: string | null }[];
    const now = Date.now();
    for (const bot of bots) {
      if (bot.homeKind === "computer") continue;
      const existing = db.prepare("SELECT id FROM environments WHERE bot_id=? AND kind='computer' AND deleted_at IS NULL").get(bot.id) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      if (!existing) db.prepare("INSERT INTO environments(id,owner_id,kind,connection,directory,bot_id,created_at) VALUES(?,?,'computer',?,'/workspace',?,?)")
        .run(id, owner, JSON.stringify({ container: `jarvy-${tag}-${bot.id.slice(0, 8)}` }), bot.id, now);
      db.prepare("UPDATE bots SET home_environment_id=?, current_environment_id=? WHERE id=?").run(id, id, bot.id);
    }
    const hosts = (db.prepare("SELECT id FROM environments WHERE kind='host' AND deleted_at IS NULL").all() as { id: string }[]).map(row => row.id);
    for (const host of hosts) {
      db.prepare("UPDATE bots SET current_environment_id=home_environment_id WHERE current_environment_id=?").run(host);
      db.prepare("DELETE FROM environment_grants WHERE environment_id=?").run(host);
      db.prepare("UPDATE environments SET deleted_at=? WHERE id=?").run(now, host);
    }
  });
}
