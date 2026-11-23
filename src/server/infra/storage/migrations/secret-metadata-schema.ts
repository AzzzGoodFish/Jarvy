import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v36 (A52): adds non-secret categorization (`category`) and structured associations (`url`, `username`) to `secrets`
 * so owners and Bots can organize and match credentials by website, account, or service without exposing secret values. */
export function migrateSecretMetadata(db: DatabaseSync): void {
  migration(db, 36, () => {
    db.exec(`
      ALTER TABLE secrets ADD COLUMN category TEXT NOT NULL DEFAULT 'other'
        CHECK(category IN ('login','api_key','database','other'));
      ALTER TABLE secrets ADD COLUMN url TEXT NOT NULL DEFAULT '';
      ALTER TABLE secrets ADD COLUMN username TEXT NOT NULL DEFAULT '';
    `);
  });
}
