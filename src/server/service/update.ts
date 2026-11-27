import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareSemver, type InstallMode, type ServerUpdatePhase, type ServerUpdateProgress,
  type UpdateApplyResult, type UpdateStatus,
} from "../../contract/update.js";
import { ValidationError } from "../shared/errors.js";
import { currentJarvyVersion, resolvePackageRoot } from "../shared/version.js";

const PACKAGE_NAME = "@goodfish/jarvy";
const REPO_RELEASES_API = "https://api.github.com/repos/AzzzGoodFish/Jarvy/releases/latest";
const REPO_RELEASES_URL = "https://github.com/AzzzGoodFish/Jarvy/releases";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 30_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

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

function cleanNpmLine(raw: string): string | null {
  const line = raw.replace(ANSI_RE, "").trim();
  if (!line) return null;
  if (/^npm warn deprecated\b/i.test(line)) return null;
  if (/packages are looking for funding|run `npm fund`/i.test(line)) return null;
  return line.slice(0, 160);
}

export async function installNpmPackageVersion(version: string, onDetail?: (line: string) => void): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ValidationError(`Invalid target version: ${version}`);
  }
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "-g", `${PACKAGE_NAME}@${version}`, "--no-fund", "--no-audit"];
  if (process.env.JARVY_NPM_REGISTRY) args.push(`--registry=${process.env.JARVY_NPM_REGISTRY}`);

  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn(npmBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const tail: string[] = [];
    let settled = false;
    let bufOut = "";
    let bufErr = "";

    const handleChunk = (chunk: Buffer, isErr: boolean) => {
      const text = (isErr ? bufErr : bufOut) + chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      const rest = lines.pop() ?? "";
      if (isErr) bufErr = rest; else bufOut = rest;
      for (const raw of lines) {
        const clean = cleanNpmLine(raw);
        if (!clean) continue;
        tail.push(clean);
        if (tail.length > 8) tail.shift();
        onDetail?.(clean);
      }
    };

    child.stdout?.on("data", (c: Buffer) => handleChunk(c, false));
    child.stderr?.on("data", (c: Buffer) => handleChunk(c, true));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectInstall(new Error("npm install timed out after 180s"));
    }, NPM_INSTALL_TIMEOUT_MS);
    timer.unref();

    child.once("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectInstall(err);
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const remOut = cleanNpmLine(bufOut);
      const remErr = cleanNpmLine(bufErr);
      if (remOut) { tail.push(remOut); onDetail?.(remOut); }
      if (remErr) { tail.push(remErr); onDetail?.(remErr); }
      if (code === 0) { resolveInstall(); return; }
      const detail = tail.slice(-3).join(" | ") || `npm install exited with code ${code ?? "unknown"}`;
      rejectInstall(new Error(detail));
    });
  });
}

/** Server update checker and non-blocking flush-and-restart coordinator with live progress state (A113, A114). */
export class UpdateService {
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private checkedAt: number | null = null;
  private updating = false;
  private lastError: string | null = null;
  private progress: ServerUpdateProgress = { phase: "idle", targetVersion: null, startedAt: null, updatedAt: null, detail: null };
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private onRestart?: () => void;

  readonly installMode: InstallMode = detectInstallMode();

  setRestartHandler(handler: () => void): void {
    this.onRestart = handler;
  }

  private setProgress(phase: ServerUpdatePhase, patch: Partial<Omit<ServerUpdateProgress, "phase">> = {}): void {
    this.progress = {
      ...this.progress,
      ...patch,
      phase,
      updatedAt: Date.now(),
    };
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
      progress: { ...this.progress },
    };
  }

  async checkNow(): Promise<UpdateStatus> {
    const prevPhase = this.progress.phase;
    if (!this.updating) this.setProgress("checking", { detail: null });
    try {
      const info = await fetchLatestReleaseInfo();
      this.latestVersion = info.version;
      this.releaseUrl = info.releaseUrl;
      this.checkedAt = Date.now();
      this.lastError = null;
      if (!this.updating) this.setProgress("idle", { targetVersion: null, startedAt: null, detail: null });
    } catch (error) {
      this.checkedAt = Date.now();
      this.lastError = error instanceof Error ? error.message : String(error);
      if (!this.updating) this.setProgress(prevPhase === "error" ? "error" : "idle");
    }
    return this.status();
  }

  /** Starts installing the npm release asynchronously (returning 202 immediately) and triggers graceful restart once installed. */
  async apply(targetVersion?: string): Promise<UpdateApplyResult> {
    if (this.updating) {
      return {
        started: true,
        targetVersion: this.progress.targetVersion ?? this.latestVersion ?? currentJarvyVersion(),
        message: "Server update is already in progress",
      };
    }
    if (this.installMode === "git") {
      throw new ValidationError("Running from a git source checkout; update with `git pull && npm run build`");
    }
    if (!this.latestVersion && !targetVersion) await this.checkNow();
    const target = targetVersion?.trim() || this.latestVersion;
    if (!target) throw new ValidationError("No release version found");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) {
      throw new ValidationError(`Invalid target version: ${target}`);
    }
    if (!targetVersion && compareSemver(target, currentJarvyVersion()) <= 0) {
      return { started: false, targetVersion: target, message: "Jarvy is already up to date" };
    }

    this.updating = true;
    this.lastError = null;
    const startedAt = Date.now();
    this.setProgress("installing", { targetVersion: target, startedAt, detail: null });
    console.log(`[update] installing ${PACKAGE_NAME}@${target}...`);

    void installNpmPackageVersion(target, line => {
      if (this.updating && this.progress.phase === "installing") {
        this.setProgress("installing", { detail: line });
      }
    }).then(() => {
      console.log(`[update] installed ${PACKAGE_NAME}@${target}; initiating graceful restart`);
      this.setProgress("restarting", { detail: null });
      const restart = this.onRestart;
      if (restart) setTimeout(restart, 300).unref();
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[update] install failed for ${PACKAGE_NAME}@${target}: ${message}`);
      this.updating = false;
      this.lastError = message;
      this.setProgress("error", { detail: message });
    });

    return { started: true, targetVersion: target, message: `Installing ${target}; server will restart automatically` };
  }
}
