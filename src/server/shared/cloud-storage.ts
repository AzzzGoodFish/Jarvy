/** Shared contracts for Phase 2 encrypted S3 cloud storage & stateless `jarvy server` (A107).
 * Keeps `src/server/shared/` free of Node/infra imports while allowing `infra/files`, `application`, and `cli`
 * to coordinate cloud persistence cleanly. */

export interface CloudStorageConfig {
  /** S3 bucket name. */
  bucket: string;
  /** Optional object key prefix inside the bucket (no leading/trailing slashes). */
  prefix: string;
  /** S3 API endpoint URL (e.g. `https://<acct>.r2.cloudflarestorage.com`, `https://oss-cn-hongkong.aliyuncs.com`). */
  endpoint: string;
  /** Signing region (defaults to `"auto"` for R2 or provider-specific region like `"us-east-1"`). */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Use path-style URLs (`https://endpoint/bucket/key`) instead of virtual-hosted (`https://bucket.endpoint/key`). */
  pathStyle: boolean;
  /** User-supplied recovery secret (base64 32-byte key or passphrase) for client-side AES-256-GCM encryption. */
  recoveryKey: string;
  /** Periodic sync interval in milliseconds (default 15_000). */
  syncIntervalMs?: number;
  /** Single-writer lease TTL in milliseconds (default 60_000). */
  leaseTtlMs?: number;
  /** When true, forcibly bump the lease epoch to take over from an unreachable/orphaned server. */
  takeover?: boolean;
}

export interface CloudLeaseSnapshot {
  holderId: string;
  hostname: string;
  epoch: number;
  acquiredAt: number;
  renewedAt: number;
  ttlMs: number;
  released?: boolean;
}

export interface CloudSyncStatus {
  enabled: boolean;
  bucket?: string;
  prefix?: string;
  endpoint?: string;
  epoch?: number;
  dbRev?: number;
  lastSyncedAt?: number | null;
  lastError?: string | null;
}

/** Optional cloud mirror injected into `AttachmentFiles` so immutable chat attachments upload to S3 on commit
 * and hydrate lazily on local cache misses (allowing tiny VPS disks to back large attachment archives). */
export interface AttachmentCloudMirror {
  uploadAttachment(id: string, localPath: string): Promise<void>;
  ensureLocalAttachment(id: string, localPath: string): Promise<boolean>;
  deleteAttachment(id: string): Promise<void>;
}

/** Parses an `s3://<bucket>[/<prefix>]` URI into normalized bucket and prefix. */
export function parseS3Uri(uri: string): { bucket: string; prefix: string } {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("s3://")) {
    throw new Error(`Invalid storage URI "${uri}": expected s3://<bucket>[/<prefix>]`);
  }
  const rest = trimmed.slice("s3://".length).replace(/^\/+|\/+$/g, "");
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const prefix = slash === -1 ? "" : rest.slice(slash + 1).replace(/^\/+|\/+$/g, "");
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(`Invalid S3 bucket name "${bucket}"`);
  }
  return { bucket, prefix };
}
