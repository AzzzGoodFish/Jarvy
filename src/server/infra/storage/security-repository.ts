import type { DatabaseSync } from "node:sqlite";
import type { SecurityAuditEvent } from "../../../contract/security.js";

export interface ThrottleRow {
  key: string;
  attempts: number;
  lockedUntil: number;
  updatedAt: number;
}

const MAX_THROTTLE_KEYS = 2000;
const MAX_AUDIT_EVENTS = 200;

/** Persistence for login throttling and security audit events (A112). */
export class SecurityRepository {
  constructor(private readonly db: DatabaseSync) {}

  getThrottle(key: string): ThrottleRow | null {
    const row = this.db.prepare(
      "SELECT key, attempts, locked_until AS lockedUntil, updated_at AS updatedAt FROM login_throttle WHERE key=?",
    ).get(key) as ThrottleRow | undefined;
    return row ?? null;
  }

  setThrottle(row: ThrottleRow): void {
    this.db.prepare(
      `INSERT INTO login_throttle(key, attempts, locked_until, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts, locked_until=excluded.locked_until, updated_at=excluded.updated_at`,
    ).run(row.key, row.attempts, row.lockedUntil, row.updatedAt);
    // Keep table bounded against public IP spray scanners.
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM login_throttle").get() as { n: number }).n;
    if (count > MAX_THROTTLE_KEYS) {
      this.db.prepare(
        "DELETE FROM login_throttle WHERE key != 'global' AND key IN (SELECT key FROM login_throttle WHERE key != 'global' ORDER BY updated_at ASC LIMIT ?)",
      ).run(count - MAX_THROTTLE_KEYS + 100);
    }
  }

  deleteThrottle(key: string): void {
    this.db.prepare("DELETE FROM login_throttle WHERE key=?").run(key);
  }

  pruneStaleThrottle(olderThanMs: number): void {
    this.db.prepare("DELETE FROM login_throttle WHERE updated_at < ? AND locked_until < ?").run(olderThanMs, Date.now());
  }

  recordEvent(kind: string, ip: string, detail: string): SecurityAuditEvent {
    const at = Date.now();
    const safeIp = ip.slice(0, 128);
    const safeDetail = detail.slice(0, 500);
    const result = this.db.prepare(
      "INSERT INTO security_events(at, kind, ip, detail) VALUES(?,?,?,?)",
    ).run(at, kind.slice(0, 64), safeIp, safeDetail);
    const id = Number(result.lastInsertRowid);
    // Ring-buffer cap in SQLite so audit log never grows unboundedly.
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM security_events").get() as { n: number }).n;
    if (count > MAX_AUDIT_EVENTS + 40) {
      this.db.prepare(
        "DELETE FROM security_events WHERE id NOT IN (SELECT id FROM security_events ORDER BY id DESC LIMIT ?)",
      ).run(MAX_AUDIT_EVENTS);
    }
    return { id, at, kind, ip: safeIp, detail: safeDetail };
  }

  recentEvents(limit = 30): SecurityAuditEvent[] {
    const cap = Math.max(1, Math.min(MAX_AUDIT_EVENTS, limit));
    return this.db.prepare(
      "SELECT id, at, kind, ip, detail FROM security_events ORDER BY id DESC LIMIT ?",
    ).all(cap) as unknown as SecurityAuditEvent[];
  }
}
