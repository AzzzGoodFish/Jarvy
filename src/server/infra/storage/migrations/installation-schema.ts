import type { DatabaseSync } from "node:sqlite";

/** Stable per-data-root identity for Pi's ChatGPT login; created on first use. */
export function migrateInstallation(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 8) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE installation (
      id INTEGER PRIMARY KEY CHECK(id=1), device_id TEXT NOT NULL
    ); PRAGMA user_version=8; COMMIT;`);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
