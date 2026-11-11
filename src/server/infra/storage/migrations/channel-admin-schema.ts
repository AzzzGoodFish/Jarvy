import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v31 (A90): who created a channel (`chats.created_by`) and which of its members are its admins
 * (`chat_members.admin`). Channels from before were created by the owner. Downgrading needs a v30 backup and matching
 * program. */
export function migrateChannelAdmins(db: DatabaseSync): void {
  migration(db, 31, () => {
    db.exec(`
      ALTER TABLE chats ADD COLUMN created_by TEXT REFERENCES members(id);
      UPDATE chats SET created_by=owner_id WHERE type='channel';
      ALTER TABLE chat_members ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK(admin IN (0,1));
    `);
  });
}
