import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BOT_COLORS } from "../../../shared/models.js";

/** v10: Bots get a figure colour (random for existing Bots) and a mood the
 * Bot sets itself; uploaded avatar images are removed together with the upload feature. */
export function migrateAppearance(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 10) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`ALTER TABLE bots ADD COLUMN color TEXT NOT NULL DEFAULT 'gray';
      ALTER TABLE bots ADD COLUMN mood TEXT NOT NULL DEFAULT 'normal';`);
    const recolor = db.prepare("UPDATE bots SET color=? WHERE id=?");
    for (const { id } of db.prepare("SELECT id FROM bots").all() as { id: string }[]) recolor.run(BOT_COLORS[randomInt(BOT_COLORS.length)]!, id);
    db.exec(`ALTER TABLE bots DROP COLUMN avatar_mime;
      ALTER TABLE bots DROP COLUMN avatar_data;
      ALTER TABLE bots DROP COLUMN avatar_updated_at;
      PRAGMA user_version=10; COMMIT;`);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
