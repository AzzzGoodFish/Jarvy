import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v36 (A52): adds semantic `category` (`login` | `api_key` | `database` | `other`) and extensible `fields_json`
 * (per-field `secret: boolean`, where secret fields are sealed under AES-256-GCM bound to `secret:<id>:<key>`). */
export function migrateSecretMetadata(db: DatabaseSync): void {
  migration(db, 36, () => {
    db.exec(`
      ALTER TABLE secrets ADD COLUMN category TEXT NOT NULL DEFAULT 'other'
        CHECK(category IN ('login','api_key','database','other'));
      ALTER TABLE secrets ADD COLUMN fields_json TEXT NOT NULL DEFAULT '[]';
    `);
  });
}
