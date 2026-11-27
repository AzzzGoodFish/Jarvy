import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CloudStorageConfig } from "../../shared/cloud-storage.js";
import { DATABASE_FILENAME } from "../storage/store.js";
import { keyDirectory } from "../vault/master-key.js";
import { decryptEnvelope, openVaultMeta, type CloudVaultMeta } from "./crypto.js";
import { S3Client } from "./s3-client.js";
import { restoreWorkspaceDown } from "./workspace-sync.js";

/** Shared cloud manifest types and disk-restore routines used by both `CloudSync.prepareBeforeOpen`
 * and standalone `jarvy server restore` (A107). */

export const LOCAL_SYNC_MARKER = ".cloud-sync.json";

export interface CloudBotState {
  historyKey?: string;
  historyHash?: string;
  historyRev?: number;
  sessions: Record<string, { key: string; sha256: string }>;
  workspaceKey?: string;
  workspaceRev?: number;
  workspaceDigest?: string;
}

export interface CloudManifestState {
  version: 1;
  epoch: number;
  updatedAt: number;
  dbKey?: string;
  dbHash?: string;
  dbRev: number;
  bots: Record<string, CloudBotState>;
}

export interface LocalSyncMarker {
  epoch: number;
  dbRev: number;
  updatedAt: number;
}

/** Restores `<config>/jarvy/<installationId>.key` from `meta/master-key.enc` if absent locally. */
export async function restoreMasterKeyFile(
  s3: S3Client,
  key: Buffer,
  prefix: string,
  installationId: string,
  overwrite = false,
): Promise<string | null> {
  const dest = join(keyDirectory(), `${installationId}.key`);
  if (!overwrite && existsSync(dest)) return dest;
  const objKey = `${prefix}meta/master-key.enc`;
  const res = await s3.get(objKey);
  if (!res) return null;
  const rawKey = decryptEnvelope(res.body, key, objKey);
  if (rawKey.length !== 32) throw new Error("Restored master key is damaged");
  await mkdir(keyDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(dest, `${rawKey.toString("base64")}\n`, { mode: 0o600 });
  await chmod(dest, 0o600);
  return dest;
}

/** Applies a decrypted `CloudManifestState` onto `dataDir` (DB, Bot history DBs, Pi JSONL sessions, workspaces). */
export async function applyCloudStateToDisk(options: {
  s3: S3Client;
  key: Buffer;
  prefix: string;
  dataDir: string;
  cloudState: CloudManifestState;
}): Promise<void> {
  const { s3, key, prefix, dataDir, cloudState } = options;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  if (cloudState.dbKey) {
    const dbObj = await s3.get(cloudState.dbKey);
    if (!dbObj) throw new Error(`Cloud database snapshot missing: ${cloudState.dbKey}`);
    const plain = decryptEnvelope(dbObj.body, key, cloudState.dbKey);
    const target = join(dataDir, DATABASE_FILENAME);
    const part = `${target}.restore.part`;
    await writeFile(part, plain, { mode: 0o600 });
    await rm(`${target}-wal`, { force: true }).catch(() => {});
    await rm(`${target}-shm`, { force: true }).catch(() => {});
    await rename(part, target);
  }

  for (const [botId, botState] of Object.entries(cloudState.bots)) {
    const botDir = join(dataDir, "bots", botId);
    if (botState.historyKey) {
      const res = await s3.get(botState.historyKey);
      if (res) {
        const histTarget = join(botDir, "history.db");
        await mkdir(dirname(histTarget), { recursive: true, mode: 0o700 });
        const part = `${histTarget}.restore.part`;
        await writeFile(part, decryptEnvelope(res.body, key, botState.historyKey), { mode: 0o600 });
        await rm(`${histTarget}-wal`, { force: true }).catch(() => {});
        await rm(`${histTarget}-shm`, { force: true }).catch(() => {});
        await rename(part, histTarget);
      }
    }
    for (const [filename, meta] of Object.entries(botState.sessions ?? {})) {
      const res = await s3.get(meta.key);
      if (!res) continue;
      const dest = join(botDir, "agent", "pi", "sessions", filename);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, decryptEnvelope(res.body, key, meta.key), { mode: 0o600 });
    }
    if (botState.workspaceKey) {
      await restoreWorkspaceDown({
        s3,
        key,
        prefix,
        manifestObjectKey: botState.workspaceKey,
        localDir: join(botDir, "workspace"),
      });
    }
  }
}

/** Standalone restore utility for `jarvy server restore`: pulls vault, master key, DB, sessions, workspaces, and optional attachments. */
export async function restoreFromCloud(
  config: CloudStorageConfig,
  dataDir: string,
  options: { force?: boolean; includeAttachments?: boolean } = {},
): Promise<{ dbRev: number; bots: number; attachments: number }> {
  const targetDir = resolve(dataDir);
  if (!options.force && existsSync(join(targetDir, DATABASE_FILENAME))) {
    throw new Error(`Target data directory already contains ${DATABASE_FILENAME}. Pass --force to overwrite.`);
  }
  const prefix = config.prefix ? `${config.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  const s3 = new S3Client({
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    pathStyle: config.pathStyle,
  });

  const vaultObj = await s3.get(`${prefix}meta/vault.json`);
  if (!vaultObj) throw new Error(`No Jarvy cloud vault found at s3://${config.bucket}/${prefix}`);
  const vault = JSON.parse(vaultObj.body.toString("utf8")) as CloudVaultMeta;
  const key = openVaultMeta(vault, config.recoveryKey);
  await restoreMasterKeyFile(s3, key, prefix, vault.installationId, Boolean(options.force));

  const stateKey = `${prefix}meta/state.json.enc`;
  const stateObj = await s3.get(stateKey);
  if (!stateObj) throw new Error(`Cloud vault exists, but no state snapshot (${stateKey}) has been uploaded yet.`);
  const cloudState = JSON.parse(decryptEnvelope(stateObj.body, key, stateKey).toString("utf8")) as CloudManifestState;
  await applyCloudStateToDisk({ s3, key, prefix, dataDir: targetDir, cloudState });

  let attachments = 0;
  if (options.includeAttachments) {
    const list = await s3.list(`${prefix}attachments/`);
    for (const item of list) {
      const m = /attachments\/([a-f\d]{2})\/([a-f\d-]+)\.enc$/.exec(item.key);
      if (!m) continue;
      const res = await s3.get(item.key);
      if (!res) continue;
      const dest = join(targetDir, "attachments", m[1]!, m[2]!);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, decryptEnvelope(res.body, key, item.key), { mode: 0o600 });
      attachments++;
    }
  }
  const marker: LocalSyncMarker = { epoch: cloudState.epoch, dbRev: cloudState.dbRev, updatedAt: Date.now() };
  await writeFile(join(targetDir, LOCAL_SYNC_MARKER), JSON.stringify(marker, null, 2), { mode: 0o600 });
  return { dbRev: cloudState.dbRev, bots: Object.keys(cloudState.bots).length, attachments };
}
