import { resolve } from "node:path";
import type { CloudStorageConfig } from "./shared/cloud-storage.js";
import { resolveCloudConfig, type CloudFlagInput } from "./infra/cloud/config.js";
import { CloudSync, restoreFromCloud } from "./infra/cloud/sync.js";
import { runningDaemon } from "./daemon.js";

/** Cloud storage CLI helpers (`--storage*`, `--recovery-key`, `--takeover`, `backup`, `restore`) for `jarvy server` (A107). */

export function parseCloudFlags(args: string[]): CloudFlagInput {
  const get = (flag: string): string | undefined => {
    const prefix = `${flag}=`;
    const inline = args.find(arg => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} needs a value`);
    return args[index + 1]!;
  };
  return {
    storage: get("--storage"),
    endpoint: get("--storage-endpoint"),
    region: get("--storage-region"),
    accessKeyId: get("--storage-access-key"),
    secretAccessKey: get("--storage-secret-key"),
    ...(args.includes("--storage-path-style") ? { pathStyle: true } : {}),
    recoveryKey: get("--recovery-key"),
    ...(args.includes("--takeover") ? { takeover: true } : {}),
  };
}

export function loadServerCloud(
  dir: string,
  args: string[],
  options: { persist?: boolean; allowGenerateRecoveryKey?: boolean } = {},
): CloudStorageConfig | undefined {
  const resolved = resolveCloudConfig(dir, parseCloudFlags(args), options);
  if (!resolved) return undefined;
  if (resolved.generatedRecoveryKey) {
    console.log([
      "Generated a new cloud encryption recovery key:",
      `  ${resolved.generatedRecoveryKey.key}`,
      `Saved locally at: ${resolved.generatedRecoveryKey.file}`,
      "Store this recovery key in a safe place (e.g. password manager). You will need it to restore on a new server.",
    ].join("\n"));
  }
  return resolved.config;
}

export async function runServerBackup(dir: string, args: string[], serverPidFile: string): Promise<void> {
  const running = runningDaemon(dir, serverPidFile);
  if (running) {
    throw new Error(`Jarvy server is currently running (pid ${running.pid}) and holds the cloud lease with automatic periodic sync. Stop it first with \`jarvy server stop\` to run a standalone offline backup.`);
  }
  const cloud = loadServerCloud(dir, args, { persist: true, allowGenerateRecoveryKey: true });
  if (!cloud) {
    throw new Error("No cloud storage configured. Pass --storage s3://<bucket>[/<prefix>] (or set JARVY_STORAGE_URL).");
  }
  const sync = new CloudSync(cloud, dir, {
    onLeaseLost: reason => { console.error(`[cloud] ${reason}`); },
  });
  await sync.prepareBeforeOpen();
  try {
    const result = await sync.syncNow("backup");
    console.log(`Backup complete → s3://${cloud.bucket}/${cloud.prefix} (dbRev=${result.dbRev}, changed=${result.changed}).`);
  } finally {
    await sync.close();
  }
}

export async function runServerRestore(dir: string, args: string[], serverPidFile: string): Promise<void> {
  const running = runningDaemon(dir, serverPidFile);
  if (running) {
    throw new Error(`Jarvy server is currently running (pid ${running.pid}). Stop it first with \`jarvy server stop\` before restoring.`);
  }
  const cloud = loadServerCloud(dir, args, { persist: true, allowGenerateRecoveryKey: false });
  if (!cloud) {
    throw new Error("No cloud storage configured. Pass --storage s3://<bucket>[/<prefix>] --recovery-key <key>.");
  }
  const force = args.includes("--force");
  const includeAttachments = args.includes("--include-attachments");
  const result = await restoreFromCloud(cloud, dir, { force, includeAttachments });
  console.log(
    `Restored from s3://${cloud.bucket}/${cloud.prefix} into ${resolve(dir)} ` +
    `(dbRev=${result.dbRev}, bots=${result.bots}${includeAttachments ? `, attachments=${result.attachments}` : ", attachments=on-demand"}).`,
  );
}
