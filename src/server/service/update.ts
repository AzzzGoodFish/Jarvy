import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { compareSemver, type InstallMode, type UpdateApplyResult, type UpdateStatus } from "../../contract/update.js";
import { ValidationError } from "../shared/errors.js";
import { currentJarvyVersion, resolvePackageRoot } from "../shared/version.js";

const execFileAsync = promisify(execFile);

const PACKAGE_NAME = "@goodfish/jarvy";
const REPO_RELEASES_API = "https://api.github.com/repos/AzzzGoodFish/Jarvy/releases/latest";
const REPO_RELEASES_URL = "https://github.com/AzzzGoodFish/Jarvy/releases";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 30_000;

export function detectInstallMode(): InstallMode {
  const root = resolvePackageRoot();
  if (existsSync(resolve(root, ".git"))) return "git";
  if (existsSync(resolve(root, "package.json"))) return "npm";
  return "unknown";
}

export async function fetchLatestReleaseInfo(): Promise<{ version: string; releaseUrl: string }> {
  const npmRegistry = (process.env.JARVY_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  const npmUrl = `${npmRegistry}/${encodeURIComponent(PACKAGE_NAME)}/latest`;
  let lastErr: unknown = null;

  // 1. Try npm registry first (usually fast globally and works with custom mirrors).
  try {
    const res = await fetch(npmUrl, {
      headers: { Accept: "application/json", "User-Agent": `jarvy/${currentJarvyVersion()}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) {
      const data = await res.json() as { version?: string };
      if (data.version && /^\d+\.\d+\.\d+/.test(data.version)) {
        return { version: data.version, releaseUrl: `${REPO_RELEASES_URL}/tag/v${data.version}` };
      }
    }
  } catch (err) { lastErr = err; }

  // 2. Fallback to GitHub Releases API.
  try {
    const res = await fetch(REPO_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `jarvy/${currentJarvyVersion()}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) {
      const data = await res.json() as { tag_name?: string; html_url?: string };
      const ver = (data.tag_name ?? "").replace(/^v/, "");
      if (ver && /^\d+\.\d+\.\d+/.test(ver)) {
        return { version: ver, releaseUrl: data.html_url || `${REPO_RELEASES_URL}/tag/v${ver}` };
      }
    }
  } catch (err) { lastErr = err; }

  throw new Error(lastErr instanceof Error ? lastErr.message : "Could not reach npm registry or GitHub Releases");
}

export async function installNpmPackageVersion(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ValidationError(`Invalid target version: ${version}`);
  }
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "-g", `${PACKAGE_NAME}@${version}`];
  if (process.env.JARVY_NPM_REGISTRY) args.push(`--registry=${process.env.JARVY_NPM_REGISTRY}`);
  await execFileAsync(npmBin, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}

/** Server update checker and safe flush-and-restart coordinator (A113). */
export class UpdateService {
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private checkedAt: number | null = null;
  private updating = false;
  private lastError: string | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private onRestart?: () => void;

  readonly installMode: InstallMode = detectInstallMode();

  setRestartHandler(handler: () => void): void {
    this.onRestart = handler;
  }

  start(): void {
    if (process.env.JARVY_UPDATE_CHECK === "0") return;
    this.initialTimer = setTimeout(() => { void this.checkNow().catch(() => {}); }, INITIAL_DELAY_MS);
    this.initialTimer.unref();
    this.intervalTimer = setInterval(() => { void this.checkNow().catch(() => {}); }, CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  stop(): void {
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = null; }
  }

  status(): UpdateStatus {
    const currentVersion = currentJarvyVersion();
    const updateAvailable = this.latestVersion !== null && compareSemver(this.latestVersion, currentVersion) > 0;
    return {
      currentVersion,
      latestVersion: this.latestVersion,
      updateAvailable,
      releaseUrl: this.releaseUrl,
      checkedAt: this.checkedAt,
      installMode: this.installMode,
      updating: this.updating,
      lastError: this.lastError,
    };
  }

  async checkNow(): Promise<UpdateStatus> {
    try {
      const info = await fetchLatestReleaseInfo();
      this.latestVersion = info.version;
      this.releaseUrl = info.releaseUrl;
      this.checkedAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.checkedAt = Date.now();
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }

  /** Installs the latest npm release and triggers a graceful flush-and-restart (A113). */
  async apply(targetVersion?: string): Promise<UpdateApplyResult> {
    if (this.updating) throw new ValidationError("An update is already in progress");
    if (this.installMode === "git") {
      throw new ValidationError("Running from a git source checkout; update with `git pull && npm run build`");
    }
    if (!this.latestVersion && !targetVersion) await this.checkNow();
    const target = targetVersion?.trim() || this.latestVersion;
    if (!target) throw new ValidationError("No release version found");
    if (!targetVersion && compareSemver(target, currentJarvyVersion()) <= 0) {
      return { started: false, targetVersion: target, message: "Jarvy is already up to date" };
    }
    this.updating = true;
    this.lastError = null;
    try {
      console.log(`[update] installing ${PACKAGE_NAME}@${target}...`);
      await installNpmPackageVersion(target);
      console.log(`[update] installed ${PACKAGE_NAME}@${target}; initiating graceful restart`);
      const restart = this.onRestart;
      if (restart) setTimeout(restart, 150).unref();
      return { started: true, targetVersion: target, message: `Installed ${target}; restarting server` };
    } catch (error) {
      this.updating = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
