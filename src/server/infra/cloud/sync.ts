import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AttachmentCloudMirror, CloudStorageConfig, CloudSyncStatus } from "../../shared/cloud-storage.js";
import { runBounded } from "../../shared/shutdown.js";
import { DATABASE_FILENAME, type Store } from "../storage/store.js";
import { readInstallationIdFromDb, snapshotSqliteFile } from "../storage/snapshot.js";
import { masterKey } from "../vault/master-key.js";
import {
  createVaultMeta, decryptEnvelope, encryptEnvelope, encryptEnvelopeAsync, encryptFileEnvelope,
  hashFileSha256, openVaultMeta, type CloudVaultMeta,
} from "./crypto.js";
import { CloudLease } from "./lease.js";
import {
  applyCloudStateToDisk, LOCAL_SYNC_MARKER, restoreFromCloud, restoreMasterKeyFile,
  type CloudBotState, type CloudManifestState, type LocalSyncMarker,
} from "./restore.js";
import { S3Client } from "./s3-client.js";
import { manifestKey, restoreWorkspaceDown, syncWorkspaceUp, type WorkspaceManifest } from "./workspace-sync.js";

export { restoreFromCloud };

/** Tiered encrypted S3 cloud sync engine for stateless `jarvy server` (A107).
 * Coordinates vault key sync, single-writer fencing lease, online SQLite backups, Pi JSONL sessions,
 * immutable chat attachments, and content-addressed Bot workspaces. */

const MAX_KEPT_DB_SNAPSHOTS = 10;
const DEFAULT_SYNC_INTERVAL_MS = 15_000;
const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

export class CloudSync {
  readonly s3: S3Client;
  readonly lease: CloudLease;
  private readonly prefix: string;
  private readonly dataDir: string;
  private readonly log: (text: string) => void;
  private encryptionKey: Buffer | null = null;
  private vaultMeta: CloudVaultMeta | null = null;
  private state: CloudManifestState = { version: 1, epoch: 0, updatedAt: 0, dbRev: 0, bots: {} };
  private store: Store | null = null;
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  private lastSyncedAt: number | null = null;
  private lastError: string | null = null;
  private readonly knownWorkspaceBlobs = new Set<string>();
  private readonly uploadedAttachments = new Set<string>();

  constructor(
    private readonly config: CloudStorageConfig,
    dataDir: string,
    options: { onLeaseLost: (reason: string) => void; log?: (text: string) => void },
  ) {
    this.dataDir = resolve(dataDir);
    this.prefix = config.prefix ? `${config.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
    this.log = options.log ?? (text => console.log(`[cloud] ${text}`));
    this.s3 = new S3Client({
      bucket: config.bucket,
      endpoint: config.endpoint,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      pathStyle: config.pathStyle,
    });
    this.lease = new CloudLease({
      s3: this.s3,
      key: `${this.prefix}lease.json`,
      ttlMs: config.leaseTtlMs,
      onLost: reason => {
        this.stopLoop();
        this.lastError = reason;
        options.onLeaseLost(reason);
      },
      log: this.log,
    });
  }

  private k(path: string): string { return `${this.prefix}${path}`; }

  /** Runs BEFORE `Store` opens: acquires fencing lease, verifies recovery key, and restores newer cloud state if needed. */
  async prepareBeforeOpen(): Promise<{ restored: boolean; epoch: number }> {
    const lease = await this.lease.acquire(Boolean(this.config.takeover));
    this.state.epoch = lease.epoch;
    this.log(`acquired lease epoch ${lease.epoch} on s3://${this.config.bucket}/${this.prefix}`);

    const vaultObj = await this.s3.get(this.k("meta/vault.json"));
    if (!vaultObj) {
      this.log("cloud bucket has no existing vault yet; will initialize on first sync");
      return { restored: false, epoch: lease.epoch };
    }

    this.vaultMeta = JSON.parse(vaultObj.body.toString("utf8")) as CloudVaultMeta;
    this.encryptionKey = openVaultMeta(this.vaultMeta, this.config.recoveryKey);
    const keyPath = await restoreMasterKeyFile(this.s3, this.encryptionKey, this.prefix, this.vaultMeta.installationId);
    if (keyPath) this.log(`master key ready at ${keyPath}`);

    const stateObj = await this.s3.get(this.k("meta/state.json.enc"));
    if (!stateObj) return { restored: false, epoch: lease.epoch };
    const cloudState = JSON.parse(decryptEnvelope(stateObj.body, this.encryptionKey, this.k("meta/state.json.enc")).toString("utf8")) as CloudManifestState;
    this.state = { ...cloudState, epoch: lease.epoch };

    const localDb = join(this.dataDir, DATABASE_FILENAME);
    const marker = await this.readLocalMarker();
    const needsRestore = !existsSync(localDb) || !marker || cloudState.dbRev > marker.dbRev || cloudState.epoch > marker.epoch;
    if (needsRestore && cloudState.dbKey) {
      this.log(`restoring newer cloud state (dbRev ${cloudState.dbRev}, epoch ${cloudState.epoch}) into ${this.dataDir}`);
      await applyCloudStateToDisk({ s3: this.s3, key: this.encryptionKey, prefix: this.prefix, dataDir: this.dataDir, cloudState });
      await this.writeLocalMarker({ epoch: lease.epoch, dbRev: cloudState.dbRev, updatedAt: Date.now() });
      return { restored: true, epoch: lease.epoch };
    }
    return { restored: false, epoch: lease.epoch };
  }

  /** Attaches the live `Store` and starts periodic background sync. */
  async attachStore(store: Store, startBackgroundLoop = true): Promise<void> {
    this.store = store;
    await this.ensureVaultInitialized(store.account.installationDeviceId());
    if (startBackgroundLoop) {
      const interval = Math.max(2_000, this.config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS);
      this.timer = setInterval(() => {
        void this.syncNow("periodic").catch(error => {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.log(`sync failed: ${this.lastError}`);
        });
      }, interval);
      this.timer.unref();
    }
  }

  /** Runs a single serialized, lease-fenced sync pass across SQLite DBs, sessions, workspaces, and attachments. */
  async syncNow(reason = "manual"): Promise<{ dbRev: number; changed: boolean }> {
    if (this.syncing) {
      await this.syncing;
      return { dbRev: this.state.dbRev, changed: false };
    }
    let changed = false;
    const work = (async () => {
      this.lease.assertHeld();
      const renewed = await this.lease.renew();
      if (!renewed) throw new Error("Cloud lease lost before sync");

      const installationId = this.store?.account.installationDeviceId() ?? readInstallationIdFromDb(join(this.dataDir, DATABASE_FILENAME));
      if (!installationId) return;
      await this.ensureVaultInitialized(installationId);
      const key = this.encryptionKey!;

      if (await this.syncMainDb(key)) changed = true;
      if (await this.syncBots(key)) changed = true;
      await this.syncLocalAttachments(key);

      if (changed || !this.lastSyncedAt) {
        this.lease.assertHeld();
        this.state.epoch = this.lease.epoch;
        this.state.updatedAt = Date.now();
        const stateKey = this.k("meta/state.json.enc");
        await this.s3.put(stateKey, encryptEnvelope(Buffer.from(JSON.stringify(this.state), "utf8"), key, stateKey, true));
        await this.writeLocalMarker({ epoch: this.state.epoch, dbRev: this.state.dbRev, updatedAt: this.state.updatedAt });
      }
      this.lastSyncedAt = Date.now();
      this.lastError = null;
      if (changed) this.log(`synced (${reason}): dbRev=${this.state.dbRev}, bots=${Object.keys(this.state.bots).length}`);
    })();
    this.syncing = work.finally(() => { this.syncing = null; });
    await this.syncing;
    return { dbRev: this.state.dbRev, changed };
  }

  /** Returns an `AttachmentCloudMirror` bound to this sync session for `AttachmentFiles`. */
  attachmentMirror(): AttachmentCloudMirror {
    return {
      uploadAttachment: async (id, localPath) => {
        if (!this.encryptionKey || !this.lease.active) return;
        const objKey = this.attachmentKey(id);
        const bytes = await readFile(localPath);
        await this.s3.put(objKey, encryptEnvelope(bytes, this.encryptionKey, objKey, false));
        this.uploadedAttachments.add(id);
      },
      ensureLocalAttachment: async (id, localPath) => {
        if (existsSync(localPath)) return true;
        if (!this.encryptionKey) return false;
        const objKey = this.attachmentKey(id);
        const res = await this.s3.get(objKey);
        if (!res) return false;
        const plain = decryptEnvelope(res.body, this.encryptionKey, objKey);
        await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
        const part = `${localPath}.cloud.part`;
        await writeFile(part, plain, { mode: 0o600 });
        await rename(part, localPath);
        this.uploadedAttachments.add(id);
        return true;
      },
      deleteAttachment: async id => {
        if (!this.lease.active) return;
        this.uploadedAttachments.delete(id);
        await this.s3.delete(this.attachmentKey(id)).catch(() => {});
      },
    };
  }

  status(): CloudSyncStatus {
    return {
      enabled: true,
      bucket: this.config.bucket,
      prefix: this.config.prefix,
      endpoint: this.config.endpoint,
      epoch: this.lease.epoch,
      dbRev: this.state.dbRev,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
  }

  /** Syncs the server's local `/workspace` for `botId` to S3 and returns Pre-signed GET URLs so a remote
   * compute node can pull the latest `workspace_rev` directly from S3 (A108). */
  async presignWorkspacePull(botId: string): Promise<{
    rev: number; manifestKey: string; manifestUrl: string;
    blobGets: Record<string, { key: string; url: string }>; keyBase64: string;
  } | null> {
    if (!this.encryptionKey || !this.lease.active) return null;
    const botState: CloudBotState = this.state.bots[botId] ?? { sessions: {} };
    const wsDir = join(this.dataDir, "bots", botId, "workspace");
    const wsResult = await syncWorkspaceUp({
      s3: this.s3, key: this.encryptionKey, prefix: this.prefix, botId, localDir: wsDir,
      prevRev: botState.workspaceRev ?? 0, prevDigest: botState.workspaceDigest ?? null,
      knownBlobs: this.knownWorkspaceBlobs, assertHeld: () => this.lease.assertHeld(),
    });
    if (wsResult.changed && wsResult.manifest) {
      botState.workspaceKey = wsResult.manifest;
      botState.workspaceRev = wsResult.rev;
      botState.workspaceDigest = wsResult.digest;
      this.state.bots[botId] = botState;
      await this.flushStateManifest();
    }
    if (!botState.workspaceKey || !botState.workspaceRev) return null;
    const obj = await this.s3.get(botState.workspaceKey);
    if (!obj) return null;
    const manifest = JSON.parse(decryptEnvelope(obj.body, this.encryptionKey, botState.workspaceKey).toString("utf8")) as WorkspaceManifest;
    const blobGets: Record<string, { key: string; url: string }> = {};
    for (const f of manifest.files) {
      if (blobGets[f.sha256]) continue;
      const bKey = `${this.prefix}workspaces/blobs/${f.sha256.slice(0, 2)}/${f.sha256}.enc`;
      blobGets[f.sha256] = { key: bKey, url: this.s3.presign("GET", bKey, 900) };
    }
    return {
      rev: manifest.rev,
      manifestKey: botState.workspaceKey,
      manifestUrl: this.s3.presign("GET", botState.workspaceKey, 900),
      blobGets,
      keyBase64: this.encryptionKey.toString("base64"),
    };
  }

  /** Signs Pre-signed PUT URLs for only the missing workspace blobs + next manifest so a remote compute node
   * can push changed workspace files directly to S3 without traversing the VPS (A108). */
  async presignWorkspacePush(
    botId: string,
    digest: string,
    files: readonly { sha256: string }[],
  ): Promise<{
    changed: boolean; rev: number; manifestKey: string; manifestUrl: string;
    blobPuts: Record<string, { key: string; url: string }>; keyBase64: string;
  } | null> {
    if (!this.encryptionKey || !this.lease.active) return null;
    const botState: CloudBotState = this.state.bots[botId] ?? { sessions: {} };
    if (botState.workspaceDigest && botState.workspaceDigest === digest) {
      return { changed: false, rev: botState.workspaceRev ?? 0, manifestKey: botState.workspaceKey ?? "", manifestUrl: "", blobPuts: {}, keyBase64: "" };
    }
    const blobPuts: Record<string, { key: string; url: string }> = {};
    for (const f of files) {
      if (blobPuts[f.sha256] || this.knownWorkspaceBlobs.has(f.sha256)) continue;
      const bKey = `${this.prefix}workspaces/blobs/${f.sha256.slice(0, 2)}/${f.sha256}.enc`;
      const exists = await this.s3.head(bKey);
      if (exists) { this.knownWorkspaceBlobs.add(f.sha256); continue; }
      blobPuts[f.sha256] = { key: bKey, url: this.s3.presign("PUT", bKey, 900) };
    }
    const nextRev = (botState.workspaceRev ?? 0) + 1;
    const mKey = manifestKey(this.prefix, botId, nextRev);
    return {
      changed: true,
      rev: nextRev,
      manifestKey: mKey,
      manifestUrl: this.s3.presign("PUT", mKey, 900),
      blobPuts,
      keyBase64: this.encryptionKey.toString("base64"),
    };
  }

  /** Records a completed direct compute-node → S3 workspace push and refreshes the server's local workspace copy. */
  async commitRemoteWorkspacePush(botId: string, input: { rev: number; digest: string; manifestKey: string; uploadedHashes: string[] }): Promise<void> {
    if (!this.encryptionKey || !this.lease.active) return;
    for (const h of input.uploadedHashes) this.knownWorkspaceBlobs.add(h);
    const botState: CloudBotState = this.state.bots[botId] ?? { sessions: {} };
    botState.workspaceRev = input.rev;
    botState.workspaceDigest = input.digest;
    botState.workspaceKey = input.manifestKey;
    this.state.bots[botId] = botState;
    await this.flushStateManifest();
    await restoreWorkspaceDown({
      s3: this.s3, key: this.encryptionKey, prefix: this.prefix,
      manifestObjectKey: input.manifestKey, localDir: join(this.dataDir, "bots", botId, "workspace"),
    }).catch(error => this.log(`local workspace refresh after remote push failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Hydrates a Bot's local `/workspace` from its latest synced S3 snapshot if the local folder is missing or empty,
   * enabling offline browsing & downloads when all compute nodes are offline (A109). */
  async ensureLocalWorkspace(botId: string): Promise<boolean> {
    if (!this.encryptionKey) return false;
    const botState = this.state.bots[botId];
    if (!botState?.workspaceKey) return false;
    const localDir = join(this.dataDir, "bots", botId, "workspace");
    const existing = await readdir(localDir).catch(() => []);
    if (existing.length > 0) return false;
    await restoreWorkspaceDown({ s3: this.s3, key: this.encryptionKey, prefix: this.prefix, manifestObjectKey: botState.workspaceKey, localDir });
    return true;
  }

  private async flushStateManifest(): Promise<void> {
    if (!this.encryptionKey) return;
    this.lease.assertHeld();
    this.state.epoch = this.lease.epoch;
    this.state.updatedAt = Date.now();
    const stateKey = this.k("meta/state.json.enc");
    await this.s3.put(stateKey, encryptEnvelope(Buffer.from(JSON.stringify(this.state), "utf8"), this.encryptionKey, stateKey, true));
    await this.writeLocalMarker({ epoch: this.state.epoch, dbRev: this.state.dbRev, updatedAt: this.state.updatedAt });
  }

  /** Flushes final consistent snapshot within a bounded budget, then always releases the single-writer lease (A114). */
  async close(options?: { syncTimeoutMs?: number; releaseTimeoutMs?: number }): Promise<void> {
    const syncMs = options?.syncTimeoutMs ?? 5_000;
    const releaseMs = options?.releaseTimeoutMs ?? 3_000;
    this.stopLoop();
    try {
      if (this.syncing) await runBounded("cloud.inflight", syncMs, () => this.syncing!, this.log);
      if (this.lease.active && this.store) await runBounded("cloud.finalSync", syncMs, () => this.syncNow("shutdown"), this.log);
    } finally {
      await runBounded("cloud.leaseRelease", releaseMs + 500, () => this.lease.release(AbortSignal.timeout(releaseMs)), this.log);
    }
  }
  private stopLoop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private attachmentKey(id: string): string {
    return this.k(`attachments/${id.slice(0, 2)}/${id}.enc`);
  }

  private async ensureVaultInitialized(installationId: string): Promise<void> {
    if (this.encryptionKey && this.vaultMeta) return;
    const existing = await this.s3.get(this.k("meta/vault.json"));
    if (existing) {
      this.vaultMeta = JSON.parse(existing.body.toString("utf8")) as CloudVaultMeta;
      this.encryptionKey = openVaultMeta(this.vaultMeta, this.config.recoveryKey);
      return;
    }
    const { meta, key } = createVaultMeta(this.config.recoveryKey, installationId);
    const localMaster = masterKey(installationId);
    const masterObjKey = this.k("meta/master-key.enc");
    await this.s3.put(masterObjKey, encryptEnvelope(localMaster.key, key, masterObjKey, false));
    await this.s3.put(this.k("meta/vault.json"), Buffer.from(JSON.stringify(meta, null, 2)), { contentType: "application/json" });
    this.vaultMeta = meta;
    this.encryptionKey = key;
    this.log(`initialized encrypted cloud vault (installation ${installationId.slice(0, 8)}, kdf=${meta.kdf})`);
  }

  private async syncMainDb(key: Buffer): Promise<boolean> {
    const dbPath = join(this.dataDir, DATABASE_FILENAME);
    if (!existsSync(dbPath)) return false;
    const tempSnap = join(this.dataDir, `.cloud-db-${Date.now()}.sqlite`);
    try {
      if (this.store) await this.store.snapshot(tempSnap);
      else await snapshotSqliteFile(dbPath, tempSnap);
      const hash = await hashFileSha256(tempSnap);
      if (hash === this.state.dbHash) return false;
      this.lease.assertHeld();
      const nextRev = this.state.dbRev + 1;
      const objKey = this.k(`db/jarvy-e${this.lease.epoch}-r${nextRev}.db.enc`);
      await this.s3.put(objKey, await encryptFileEnvelope(tempSnap, key, objKey, true));
      this.state.dbKey = objKey;
      this.state.dbHash = hash;
      this.state.dbRev = nextRev;
      await this.flushStateManifest();
      void this.pruneOldDbSnapshots().catch(() => {});
      return true;
    } finally {
      await rm(tempSnap, { force: true }).catch(() => {});
    }
  }

  private async pruneOldDbSnapshots(): Promise<void> {
    const items = await this.s3.list(this.k("db/jarvy-"));
    if (items.length <= MAX_KEPT_DB_SNAPSHOTS) return;
    const revOf = (k: string) => Number(/-r(\d+)\.db\.enc$/.exec(k)?.[1] ?? "0");
    items.sort((a, b) => revOf(a.key) - revOf(b.key));
    for (const stale of items.slice(0, items.length - MAX_KEPT_DB_SNAPSHOTS)) {
      if (stale.key === this.state.dbKey) continue;
      await this.s3.delete(stale.key).catch(() => {});
    }
  }

  private async syncBots(key: Buffer): Promise<boolean> {
    const botsRoot = join(this.dataDir, "bots");
    const entries = await readdir(botsRoot, { withFileTypes: true }).catch(() => []);
    let anyChanged = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const botId = entry.name;
      const botDir = join(botsRoot, botId);
      const botState: CloudBotState = this.state.bots[botId] ?? { sessions: {} };

      const histPath = join(botDir, "history.db");
      if (existsSync(histPath)) {
        const tempHist = join(this.dataDir, `.cloud-hist-${botId.slice(0, 8)}-${Date.now()}.sqlite`);
        try {
          await snapshotSqliteFile(histPath, tempHist);
          const hash = await hashFileSha256(tempHist);
          if (hash !== botState.historyHash) {
            this.lease.assertHeld();
            const rev = (botState.historyRev ?? 0) + 1;
            const objKey = this.k(`bots/${botId}/history-r${rev}.db.enc`);
            await this.s3.put(objKey, await encryptFileEnvelope(tempHist, key, objKey, true));
            botState.historyKey = objKey;
            botState.historyHash = hash;
            botState.historyRev = rev;
            this.state.bots[botId] = botState;
            await this.flushStateManifest();
            anyChanged = true;
          }
        } finally {
          await rm(tempHist, { force: true }).catch(() => {});
        }
      }

      const sessDir = join(botDir, "agent", "pi", "sessions");
      const sessFiles = await readdir(sessDir).catch(() => []);
      for (const file of sessFiles) {
        if (!file.endsWith(".jsonl")) continue;
        const bytes = await readFile(join(sessDir, file)).catch(() => null);
        if (!bytes) continue;
        const hash = sha256(bytes);
        if (botState.sessions[file]?.sha256 === hash) continue;
        this.lease.assertHeld();
        const objKey = this.k(`bots/${botId}/sessions/${file}.enc`);
        await this.s3.put(objKey, await encryptEnvelopeAsync(bytes, key, objKey, true));
        botState.sessions[file] = { key: objKey, sha256: hash };
        anyChanged = true;
      }

      const wsResult = await syncWorkspaceUp({
        s3: this.s3,
        key,
        prefix: this.prefix,
        botId,
        localDir: join(botDir, "workspace"),
        prevRev: botState.workspaceRev ?? 0,
        prevDigest: botState.workspaceDigest ?? null,
        knownBlobs: this.knownWorkspaceBlobs,
        assertHeld: () => this.lease.assertHeld(),
      });
      if (wsResult.changed && wsResult.manifest) {
        botState.workspaceKey = wsResult.manifest;
        botState.workspaceRev = wsResult.rev;
        botState.workspaceDigest = wsResult.digest;
        anyChanged = true;
      }
      this.state.bots[botId] = botState;
    }
    return anyChanged;
  }

  private async syncLocalAttachments(key: Buffer): Promise<void> {
    const attRoot = join(this.dataDir, "attachments");
    const shards = await readdir(attRoot, { withFileTypes: true }).catch(() => []);
    for (const shard of shards) {
      if (!shard.isDirectory() || !/^[a-f\d]{2}$/.test(shard.name)) continue;
      const files = await readdir(join(attRoot, shard.name)).catch(() => []);
      for (const name of files) {
        if (name.endsWith(".thumb") || name.endsWith(".part") || this.uploadedAttachments.has(name)) continue;
        const objKey = this.attachmentKey(name);
        const exists = await this.s3.head(objKey);
        if (!exists) {
          this.lease.assertHeld();
          const bytes = await readFile(join(attRoot, shard.name, name)).catch(() => null);
          if (!bytes) continue;
          await this.s3.put(objKey, encryptEnvelope(bytes, key, objKey, false));
        }
        this.uploadedAttachments.add(name);
      }
    }
  }

  private async readLocalMarker(): Promise<LocalSyncMarker | null> {
    return readFile(join(this.dataDir, LOCAL_SYNC_MARKER), "utf8")
      .then(text => JSON.parse(text) as LocalSyncMarker)
      .catch(() => null);
  }

  private async writeLocalMarker(marker: LocalSyncMarker): Promise<void> {
    await writeFile(join(this.dataDir, LOCAL_SYNC_MARKER), JSON.stringify(marker, null, 2), { mode: 0o600 });
  }
}
