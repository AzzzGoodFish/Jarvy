/** Encrypted S3 cloud storage status and manual sync result for Settings → Storage (A107, A109). */
export interface CloudStorageStatus {
  enabled: boolean;
  bucket?: string;
  prefix?: string;
  endpoint?: string;
  epoch?: number;
  dbRev?: number;
  lastSyncedAt?: number | null;
  lastError?: string | null;
}

export interface CloudSyncResult {
  status: CloudStorageStatus;
  changed: boolean;
}
