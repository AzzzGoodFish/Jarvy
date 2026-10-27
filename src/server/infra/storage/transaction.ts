import type { DatabaseSync } from "node:sqlite";

/** Runs `work` in one write transaction: BEGIN IMMEDIATE takes the write lock up front, so what `work` reads stays
 * true until it commits. Returns what `work` returns; a throw rolls everything back and is rethrown. Transactions don't
 * nest: `work` never calls another method that opens one. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** How a new schema version is written (v26 on). The version check, the transaction and `PRAGMA user_version` are
 * here; `work` holds only the change. `rebuild` is for a change that recreates tables (create new, copy, drop old,
 * rename): foreign keys are off while it runs, since SQLite ignores that pragma inside a transaction, and
 * `foreign_key_check` must come back empty before the commit. Versions up to v25 keep the code that ran on people's
 * databases. */
export function migration(db: DatabaseSync, version: number, work: () => void, { rebuild = false }: { rebuild?: boolean } = {}): void {
  if (userVersion(db) >= version) return;
  if (rebuild) db.exec("PRAGMA foreign_keys=OFF");
  try {
    transaction(db, () => {
      work();
      if (rebuild && db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Migration has invalid references");
      db.exec(`PRAGMA user_version=${version}`);
    });
  } finally { if (rebuild) db.exec("PRAGMA foreign_keys=ON"); }
}

export const userVersion = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
