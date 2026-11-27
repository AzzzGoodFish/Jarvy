import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseS3Uri, type CloudStorageConfig } from "../../shared/cloud-storage.js";
import { keyDirectory } from "../vault/master-key.js";
import { generateRecoveryKey } from "./crypto.js";

/** Loads, validates, and persists S3 cloud storage configuration from CLI flags, env vars, and `<data-dir>/cloud.json` (A107). */

interface SavedCloudFile {
  storage: string;
  endpoint: string;
  region: string;
  pathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface CloudFlagInput {
  storage?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  pathStyle?: boolean;
  recoveryKey?: string;
  takeover?: boolean;
}

export const cloudConfigPath = (dataDir: string) => join(resolve(dataDir), "cloud.json");
const recoveryKeyFile = () => join(keyDirectory(), "cloud-recovery.key");

function readSavedCloud(dataDir: string): SavedCloudFile | null {
  try { return JSON.parse(readFileSync(cloudConfigPath(dataDir), "utf8")) as SavedCloudFile; } catch { return null; }
}

export function saveCloudConfig(dataDir: string, config: CloudStorageConfig): void {
  const uri = config.prefix ? `s3://${config.bucket}/${config.prefix}` : `s3://${config.bucket}`;
  const saved: SavedCloudFile = {
    storage: uri,
    endpoint: config.endpoint,
    region: config.region,
    pathStyle: config.pathStyle,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
  mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
  writeFileSync(cloudConfigPath(dataDir), JSON.stringify(saved, null, 2), { mode: 0o600 });
}

function loadOrCreateRecoveryKey(explicit?: string, allowGenerate = true): { key: string; generated: boolean; file?: string } {
  const fromInput = explicit?.trim() || process.env.JARVY_RECOVERY_KEY?.trim();
  if (fromInput) return { key: fromInput, generated: false };
  const file = recoveryKeyFile();
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return { key: saved, generated: false, file };
  }
  if (!allowGenerate) {
    throw new Error("Recovery key is required: pass --recovery-key <key> or set JARVY_RECOVERY_KEY.");
  }
  const generated = generateRecoveryKey();
  mkdirSync(keyDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  return { key: generated, generated: true, file };
}

/** Resolves effective `CloudStorageConfig` if cloud storage is requested via flags, env vars, or `<data-dir>/cloud.json`.
 * Returns `null` when running in pure local mode. */
export function resolveCloudConfig(
  dataDir: string,
  flags: CloudFlagInput,
  options: { allowGenerateRecoveryKey?: boolean; persist?: boolean } = {},
): { config: CloudStorageConfig; generatedRecoveryKey?: { key: string; file: string } } | null {
  const saved = readSavedCloud(dataDir);
  const storageUri = flags.storage ?? process.env.JARVY_STORAGE_URL ?? saved?.storage;
  if (!storageUri) return null;

  const { bucket, prefix } = parseS3Uri(storageUri);
  const endpoint = flags.endpoint ?? process.env.JARVY_STORAGE_ENDPOINT ?? saved?.endpoint ?? "https://s3.amazonaws.com";
  const region = flags.region ?? process.env.JARVY_STORAGE_REGION ?? saved?.region ?? "auto";
  const accessKeyId = flags.accessKeyId ?? process.env.JARVY_STORAGE_ACCESS_KEY ?? process.env.AWS_ACCESS_KEY_ID ?? saved?.accessKeyId ?? "";
  const secretAccessKey = flags.secretAccessKey ?? process.env.JARVY_STORAGE_SECRET_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? saved?.secretAccessKey ?? "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Cloud storage credentials missing: set --storage-access-key / --storage-secret-key (or JARVY_STORAGE_ACCESS_KEY / JARVY_STORAGE_SECRET_KEY).");
  }

  const envPathStyle = process.env.JARVY_STORAGE_PATH_STYLE;
  const pathStyle = flags.pathStyle
    ?? (envPathStyle === "1" || envPathStyle === "true" ? true : envPathStyle === "0" || envPathStyle === "false" ? false : saved?.pathStyle);

  const recovery = loadOrCreateRecoveryKey(flags.recoveryKey, options.allowGenerateRecoveryKey ?? true);
  const syncIntervalMs = process.env.JARVY_SYNC_INTERVAL_MS ? Number(process.env.JARVY_SYNC_INTERVAL_MS) : undefined;
  const leaseTtlMs = process.env.JARVY_LEASE_TTL_MS ? Number(process.env.JARVY_LEASE_TTL_MS) : undefined;

  const config: CloudStorageConfig = {
    bucket,
    prefix,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    pathStyle: pathStyle ?? false,
    recoveryKey: recovery.key,
    ...(syncIntervalMs && Number.isFinite(syncIntervalMs) ? { syncIntervalMs } : {}),
    ...(leaseTtlMs && Number.isFinite(leaseTtlMs) ? { leaseTtlMs } : {}),
    ...(flags.takeover ? { takeover: true } : {}),
  };

  if (options.persist && (flags.storage || flags.endpoint)) saveCloudConfig(dataDir, config);
  return {
    config,
    ...(recovery.generated && recovery.file ? { generatedRecoveryKey: { key: recovery.key, file: recovery.file } } : {}),
  };
}
