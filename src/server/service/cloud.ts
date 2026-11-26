import type { CloudStorageStatus, CloudSyncResult } from "../../contract/cloud.js";
import type { CloudSync } from "../infra/cloud/sync.js";
import { ChatError } from "../shared/chat.js";

/** Service wrapper around optional encrypted S3 cloud sync (A107, A109) so API routes stay decoupled from infra. */
export class CloudService {
  constructor(private readonly cloud: CloudSync | null) {}

  status(): CloudStorageStatus {
    return this.cloud ? this.cloud.status() : { enabled: false };
  }

  async syncNow(): Promise<CloudSyncResult> {
    if (!this.cloud) {
      throw new ChatError(409, "Cloud storage is not enabled on this server");
    }
    const { changed } = await this.cloud.syncNow("manual");
    return { status: this.cloud.status(), changed };
  }
}
