import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareSemver, type UpdateStatus } from "../contract/update.js";
import { call, type Trust } from "./connector.js";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@goodfish/jarvy";

export function clientPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function clientCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(clientPackageRoot(), "package.json"), "utf8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch { /* standalone connector.mjs bundle */ }
  return "0.0.0";
}

export function clientIsGitCheckout(): boolean {
  return existsSync(resolve(clientPackageRoot(), ".git"));
}

/** Queries the paired Jarvy server's `/api/system/update` using the device token to learn about releases without needing direct Internet access. */
export async function fetchServerUpdateInfo(server: string, trust: Trust, token: string): Promise<UpdateStatus | null> {
  try {
    const res = await call(server, trust, "GET", "/api/system/update", {
      headers: { Authorization: `Device ${token}` },
    });
    if (res.status !== 200) return null;
    return JSON.parse(res.body.toString("utf8")) as UpdateStatus;
  } catch {
    return null;
  }
}

export async function installClientNpmVersion(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid version: ${version}`);
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "-g", `${PACKAGE_NAME}@${version}`];
  if (process.env.JARVY_NPM_REGISTRY) args.push(`--registry=${process.env.JARVY_NPM_REGISTRY}`);
  await execFileAsync(npmBin, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}

/** Spawns a fresh detached copy of the current CLI command (used when not supervised by systemd). */
export function respawnDetachedSelf(): void {
  if (process.env.INVOCATION_ID) return; // systemd Restart=always will launch the newly installed binary immediately on exit(0).
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export interface ClientAutoUpdaterOptions {
  server: string;
  trust: Trust;
  token: string;
  isIdle: () => boolean;
  onBeforeRestart: () => void;
  log?: (msg: string) => void;
}

/** Idle auto-updater for `jarvy client` (A113): checks server version & `/api/system/update`, installs npm release
 * when packaged (never mutates a git checkout), waits until idle, and restarts without stopping running sandboxes/VMs. */
export class ClientAutoUpdater {
  private timer: NodeJS.Timeout | null = null;
  private waitIdleTimer: NodeJS.Timeout | null = null;
  private running = false;
  private noticedVersion: string | null = null;
  private stopped = false;

  constructor(private readonly opts: ClientAutoUpdaterOptions) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => { void this.check(); }, 4 * 60 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.waitIdleTimer) { clearTimeout(this.waitIdleTimer); this.waitIdleTimer = null; }
  }

  notifyServerVersion(serverVersion?: string): void {
    if (this.stopped) return;
    const current = clientCurrentVersion();
    if (current === "0.0.0") return; // standalone connector.mjs without package.json
    if (serverVersion && compareSemver(serverVersion, current) > 0) {
      void this.scheduleUpdate(serverVersion);
      return;
    }
    void this.check();
  }

  async check(): Promise<void> {
    if (this.stopped || this.running) return;
    const current = clientCurrentVersion();
    if (current === "0.0.0") return;
    const info = await fetchServerUpdateInfo(this.opts.server, this.opts.trust, this.opts.token);
    if (!info) return;
    const candidate = info.latestVersion && compareSemver(info.latestVersion, info.currentVersion) > 0
      ? info.latestVersion
      : info.currentVersion;
    if (candidate && compareSemver(candidate, current) > 0) {
      await this.scheduleUpdate(candidate);
    }
  }

  private async scheduleUpdate(targetVersion: string): Promise<void> {
    if (this.stopped || this.running) return;
    const log = this.opts.log ?? console.log;
    if (clientIsGitCheckout()) {
      if (this.noticedVersion !== targetVersion) {
        this.noticedVersion = targetVersion;
        log(`[update] Jarvy v${targetVersion} is available (running from git checkout; update manually with git pull && npm run build)`);
      }
      return;
    }
    this.running = true;
    try {
      log(`[update] installing ${PACKAGE_NAME}@${targetVersion}...`);
      await installClientNpmVersion(targetVersion);
      log(`[update] installed ${PACKAGE_NAME}@${targetVersion}; waiting for idle before graceful restart...`);
      this.waitUntilIdleAndRestart();
    } catch (error) {
      this.running = false;
      log(`[update] auto-update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private waitUntilIdleAndRestart(): void {
    if (this.stopped) return;
    if (!this.opts.isIdle()) {
      this.waitIdleTimer = setTimeout(() => this.waitUntilIdleAndRestart(), 2000);
      this.waitIdleTimer.unref();
      return;
    }
    const log = this.opts.log ?? console.log;
    log("[update] client is idle; restarting into new version (running sandboxes/VMs stay alive)...");
    this.opts.onBeforeRestart();
    respawnDetachedSelf();
    setTimeout(() => process.exit(0), 250);
  }
}
