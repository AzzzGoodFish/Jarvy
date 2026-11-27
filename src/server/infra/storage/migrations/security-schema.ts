import type { DatabaseSync } from "node:sqlite";
import { migration } from "../transaction.js";

/** v37 (A112): persistent dual-layer login throttling (survives restarts) and structured security audit events. */
export function migrateSecurity(db: DatabaseSync): void {
  migration(db, 37, () => {
    db.exec(`
      CREATE TABLE login_throttle(
        key TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        locked_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX login_throttle_updated ON login_throttle(updated_at);
      CREATE TABLE security_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ip TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX security_events_at ON security_events(at DESC);
    `);
  });
}
