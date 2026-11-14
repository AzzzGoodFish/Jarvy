import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v32 (A93): the agent Bot's oversight. `agent_actions` is the log of what it did with its owner's powers: what it
 * read beyond its own chats, where it worked, what it changed and what the owner answered on a card. An environment
 * grant can last only for one run (`environment_grants.run_id`), as a secret's can. Downgrading needs a v31 backup
 * and matching program. */
export function migrateOversight(db: DatabaseSync): void {
  migration(db, 32, () => {
    db.exec(`
      CREATE TABLE agent_actions(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(id), at INTEGER NOT NULL,
        tool TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT 'done');
      CREATE INDEX agent_actions_bot ON agent_actions(bot_id, id);
      ALTER TABLE environment_grants ADD COLUMN run_id TEXT;
    `);
  });
}
