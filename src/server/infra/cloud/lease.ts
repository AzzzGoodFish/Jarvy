import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { CloudLeaseSnapshot } from "../../shared/cloud-storage.js";
import { S3ConflictError, type S3Client } from "./s3-client.js";

/** Single-writer fencing lease stored at `<prefix>/lease.json` using S3 conditional PUTs (A107).
 * Guarantees that an orphaned/unreachable VPS cannot keep overwriting cloud data once a new server takes over. */

const DEFAULT_TTL_MS = 60_000;
const MAX_ACQUIRE_ATTEMPTS = 3;

export interface CloudLeaseOptions {
  s3: S3Client;
  key: string;
  ttlMs?: number;
  onLost: (reason: string) => void;
  log?: (text: string) => void;
}

export class CloudLease {
  readonly holderId = randomUUID();
  private readonly ttlMs: number;
  private readonly log: (text: string) => void;
  private current: CloudLeaseSnapshot | null = null;
  private etag: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private renewing = false;
  private lost = false;
  private released = false;

  constructor(private readonly options: CloudLeaseOptions) {
    this.ttlMs = Math.max(5_000, options.ttlMs ?? DEFAULT_TTL_MS);
    this.log = options.log ?? (text => console.log(`[cloud-lease] ${text}`));
  }

  get epoch(): number { return this.current?.epoch ?? 0; }
  get snapshot(): CloudLeaseSnapshot | null { return this.current; }
  get active(): boolean { return this.current !== null && !this.lost && !this.released; }

  /** Acquires the single-writer lease. Refuses if another live holder owns an unexpired lease unless `takeover` is true. */
  async acquire(takeover = false): Promise<CloudLeaseSnapshot> {
    for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const existing = await this.options.s3.get(this.options.key);
      const now = Date.now();

      if (!existing) {
        const next: CloudLeaseSnapshot = {
          holderId: this.holderId,
          hostname: hostname(),
          epoch: 1,
          acquiredAt: now,
          renewedAt: now,
          ttlMs: this.ttlMs,
        };
        try {
          const put = await this.options.s3.put(this.options.key, Buffer.from(JSON.stringify(next, null, 2)), {
            ifNoneMatch: "*",
            contentType: "application/json",
          });
          this.current = next;
          this.etag = put.etag;
          this.lost = false;
          this.released = false;
          this.startHeartbeat();
          return next;
        } catch (error) {
          if (error instanceof S3ConflictError && attempt < MAX_ACQUIRE_ATTEMPTS) continue;
          throw error;
        }
      }

      const prev = JSON.parse(existing.body.toString("utf8")) as CloudLeaseSnapshot;
      const expired = prev.released === true || (now - prev.renewedAt) > (prev.ttlMs || this.ttlMs);
      if (!expired && !takeover && prev.holderId !== this.holderId) {
        const ageSec = Math.max(0, Math.round((now - prev.renewedAt) / 1000));
        throw new Error(
          `Cloud storage lease is held by ${prev.hostname} (holder ${prev.holderId.slice(0, 8)}, epoch ${prev.epoch}, renewed ${ageSec}s ago). ` +
          `Stop that server first, wait for its lease to expire, or restart with --takeover.`,
        );
      }

      const next: CloudLeaseSnapshot = {
        holderId: this.holderId,
        hostname: hostname(),
        epoch: (prev.epoch || 0) + 1,
        acquiredAt: now,
        renewedAt: now,
        ttlMs: this.ttlMs,
      };
      try {
        const put = await this.options.s3.put(this.options.key, Buffer.from(JSON.stringify(next, null, 2)), {
          ifMatch: existing.etag,
          contentType: "application/json",
        });
        this.current = next;
        this.etag = put.etag;
        this.lost = false;
        this.released = false;
        this.startHeartbeat();
        if (takeover && !expired) {
          this.log(`took over lease from ${prev.hostname} (${prev.holderId.slice(0, 8)}): epoch ${prev.epoch} → ${next.epoch}`);
        }
        return next;
      } catch (error) {
        if (error instanceof S3ConflictError && attempt < MAX_ACQUIRE_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new Error("Could not acquire cloud storage lease after concurrent conflict retries");
  }

  /** Verifies and renews the lease before sensitive writes or on the heartbeat interval. */
  async renew(): Promise<boolean> {
    if (!this.current || !this.etag || this.lost || this.released) return false;
    if (this.renewing) return !this.lost;
    this.renewing = true;
    try {
      const next: CloudLeaseSnapshot = { ...this.current, renewedAt: Date.now() };
      const put = await this.options.s3.put(this.options.key, Buffer.from(JSON.stringify(next, null, 2)), {
        ifMatch: this.etag,
        contentType: "application/json",
      });
      this.current = next;
      this.etag = put.etag;
      return true;
    } catch (error) {
      if (error instanceof S3ConflictError) {
        this.markLost("Another Jarvy server took over the cloud storage lease");
        return false;
      }
      const elapsed = Date.now() - this.current.renewedAt;
      if (elapsed >= this.ttlMs) {
        this.markLost(`Cloud lease renewal failed past TTL (${error instanceof Error ? error.message : String(error)})`);
        return false;
      }
      this.log(`lease renewal warning (will retry): ${error instanceof Error ? error.message : String(error)}`);
      return true;
    } finally {
      this.renewing = false;
    }
  }

  /** Throws immediately if this process no longer holds the active lease. */
  assertHeld(): void {
    if (!this.active) throw new Error("Cloud storage lease is no longer held");
  }

  /** Gracefully marks the lease released while keeping `epoch` monotonic for the next holder. */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.current || !this.etag || this.lost || this.released) return;
    this.released = true;
    const closed: CloudLeaseSnapshot = { ...this.current, renewedAt: 0, released: true };
    try {
      await this.options.s3.put(this.options.key, Buffer.from(JSON.stringify(closed, null, 2)), {
        ifMatch: this.etag,
        contentType: "application/json",
      });
    } catch {
      /* ignore release conflict if another server already took over */
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = Math.max(2_000, Math.floor(this.ttlMs / 3));
    this.timer = setInterval(() => { void this.renew(); }, interval);
    this.timer.unref();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private markLost(reason: string): void {
    if (this.lost) return;
    this.lost = true;
    this.stopHeartbeat();
    this.log(`FENCING: ${reason}`);
    this.options.onLost(reason);
  }
}
