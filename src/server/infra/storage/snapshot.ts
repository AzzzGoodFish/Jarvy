import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/** Consistent online SQLite backup helpers (A107).
 * Kept inside `infra/storage/` to satisfy Jarvy's `node:sqlite` layer boundary (`check-boundaries.mjs`). */

/** Creates a consistent point-in-time snapshot of an on-disk SQLite database (WAL-safe via SQLite Online Backup API). */
export async function snapshotSqliteFile(sourcePath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(db, destPath);
  } finally {
    db.close();
  }
}

/** Reads `installation.device_id` from a SQLite `jarvy.db` file without opening the full `Store`. */
export function readInstallationIdFromDb(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT device_id FROM installation LIMIT 1").get() as { device_id?: string } | undefined;
    return typeof row?.device_id === "string" && row.device_id ? row.device_id : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
