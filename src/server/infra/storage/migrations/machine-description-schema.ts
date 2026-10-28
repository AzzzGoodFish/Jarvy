import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v27 (A57): an SSH machine has a description the owner writes (what it is for, what is installed there, what to
 * watch out for), which Bots read in environments.list. A column added, empty for existing rows; no rows rewritten.
 * Downgrading needs a v26 backup and matching program. */
export function migrateMachineDescriptions(db: DatabaseSync): void {
  migration(db, 27, () => db.exec("ALTER TABLE environments ADD COLUMN description TEXT NOT NULL DEFAULT ''"));
}
