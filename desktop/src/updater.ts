import { app, dialog, Notification, shell, type NativeImage } from "electron";
import { createWriteStream } from "node:fs";
import { chmod, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { compareSemver } from "../../src/contract/update.js";
import type { DesktopUpdatePhase, DesktopUpdateProgress, DesktopUpdateStatus } from "../../src/contract/desktop.js";
import { fetchServerUpdateInfo } from "../../src/connect/updater.js";
import type { Trust } from "../../src/connect/connector.js";
import { say } from "./text.js";

const REPO_RELEASES_API = "https://api.github.com/repos/AzzzGoodFish/Jarvy/releases/latest";
const REPO_RELEASES_URL = "https://github.com/AzzzGoodFish/Jarvy/releases";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface DesktopUpdateInfo {
  version: string;
  releaseUrl: string;
  assetUrl: string | null;
}

interface GithubReleasePayload {
  tag_name?: string;
  html_url?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/** Checks connected Jarvy server + GitHub Releases, notifies in tray, and performs one-click install & restart (A113). */
export class DesktopUpdater {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private available: DesktopUpdateInfo | null = null;
  private notifiedVersion: string | null = null;
  private busy = false;
  private progress: DesktopUpdateProgress = {
    phase: "idle", targetVersion: null, bytesReceived: 0, totalBytes: null, bytesPerSec: null, startedAt: null, error: null,
  };

  constructor(
    private readonly currentVersion: string,
    private readonly icon: NativeImage,
    private readonly getServerAuth: () => { server: string; trust: Trust; token: string } | null,
    private readonly onAvailableChanged: (info: DesktopUpdateInfo | null) => void,
    private readonly onBeforeQuit: () => void,
    private readonly onProgressChanged?: (status: DesktopUpdateStatus) => void,
  ) {}

  private emitProgress(phase: DesktopUpdatePhase, patch: Partial<Omit<DesktopUpdateProgress, "phase">> = {}): void {
    this.progress = { ...this.progress, ...patch, phase };
    this.onProgressChanged?.(this.status());
  }

  start(): void {
    this.initialTimer = setTimeout(() => { void this.check(false); }, 15_000);
    this.timer = setInterval(() => { void this.check(false); }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  currentAvailable(): DesktopUpdateInfo | null { return this.available; }

  private supportsDirectInstall(info: DesktopUpdateInfo | null): boolean {
    return !!info?.assetUrl && (process.platform === "win32" || (process.platform === "linux" && !!process.env.APPIMAGE));
  }

  status(): DesktopUpdateStatus {
    const avail = this.available;
    return {
      currentVersion: this.currentVersion,
      latestVersion: avail?.version ?? null,
      updateAvailable: !!avail && compareSemver(avail.version, this.currentVersion) > 0,
      releaseUrl: avail?.releaseUrl ?? null,
      canDirectInstall: this.supportsDirectInstall(avail),
      progress: { ...this.progress },
    };
  }

  /** Silent probe triggered from Settings → About (no native popups; returns current state). */
  async checkQuiet(): Promise<DesktopUpdateStatus> {
    if (this.busy) return this.status();
    this.emitProgress("checking", { error: null });
    try {
      const found = await this.probeLatest();
      if (found && compareSemver(found.version, this.currentVersion) > 0) {
        this.available = found;
        this.onAvailableChanged(found);
      } else {
        this.available = null;
        this.onAvailableChanged(null);
      }
    } catch { /* return last known state */ }
    if (!this.busy) this.emitProgress("idle", { targetVersion: null, bytesReceived: 0, totalBytes: null, bytesPerSec: null, startedAt: null, error: null });
    return this.status();
  }

  /** Starts downloading & installing the available desktop update asynchronously so UI gets live byte progress immediately. */
  async installFromPage(): Promise<{ started: boolean; error?: string }> {
    if (this.busy) return { started: true };
    if (!this.available) await this.checkQuiet();
    const info = this.available;
    if (!info || compareSemver(info.version, this.currentVersion) <= 0) {
      return { started: false, error: "Desktop client is already up to date" };
    }
    if (!this.supportsDirectInstall(info) || !info.assetUrl) {
      await shell.openExternal(info.releaseUrl);
      return { started: true };
    }
    this.busy = true;
    this.emitProgress("downloading", {
      targetVersion: info.version, bytesReceived: 0, totalBytes: null, bytesPerSec: null, startedAt: Date.now(), error: null,
    });
    void this.runDirectInstall(info).catch(error => {
      this.busy = false;
      this.emitProgress("error", { error: error instanceof Error ? error.message : String(error), bytesPerSec: null });
    });
    return { started: true };
  }

  async check(interactive: boolean): Promise<void> {
    if (this.busy) return;
    try {
      const found = await this.probeLatest();
      if (found && compareSemver(found.version, this.currentVersion) > 0) {
        this.available = found;
        this.onAvailableChanged(found);
        if (interactive) {
          await this.promptAndInstall(found);
        } else if (this.notifiedVersion !== found.version && Notification.isSupported()) {
          this.notifiedVersion = found.version;
          const note = new Notification({
            title: say("updateAvailableTitle", { version: found.version }),
            body: say("updateAvailableBody"),
            icon: this.icon,
          });
          note.on("click", () => { void this.promptAndInstall(found); });
          note.show();
        }
      } else {
        this.available = null;
        this.onAvailableChanged(null);
        if (interactive) {
          await dialog.showMessageBox({
            type: "info",
            title: say("appName"),
            message: say("updateUpToDate", { version: this.currentVersion }),
          });
        }
      }
    } catch (error) {
      if (interactive) {
        await dialog.showMessageBox({
          type: "warning",
          title: say("appName"),
          message: say("updateCheckFailed", { reason: error instanceof Error ? error.message : String(error) }),
        });
      }
    }
  }

  async installAvailable(): Promise<void> {
    if (this.available) await this.promptAndInstall(this.available);
    else await this.check(true);
  }

  private async probeLatest(): Promise<DesktopUpdateInfo | null> {
    let version: string | null = null;
    let releaseUrl: string | null = null;
    let assetUrl: string | null = null;

    // 1. Prefer connected Jarvy server's cached update info (works behind firewalls / proxies).
    const auth = this.getServerAuth();
    if (auth) {
      const serverInfo = await fetchServerUpdateInfo(auth.server, auth.trust, auth.token);
      if (serverInfo) {
        const best = serverInfo.latestVersion && compareSemver(serverInfo.latestVersion, serverInfo.currentVersion) > 0
          ? serverInfo.latestVersion
          : serverInfo.currentVersion;
        if (best) {
          version = best;
          releaseUrl = serverInfo.releaseUrl ?? `${REPO_RELEASES_URL}/tag/v${best}`;
        }
      }
    }

    // 2. Query GitHub Releases for latest tag & platform installer asset URL.
    try {
      const res = await fetch(REPO_RELEASES_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `jarvy-desktop/${this.currentVersion}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) {
        const gh = await res.json() as GithubReleasePayload;
        const ghVer = (gh.tag_name ?? "").replace(/^v/, "");
        if (ghVer && (!version || compareSemver(ghVer, version) >= 0)) {
          version = ghVer;
          releaseUrl = gh.html_url ?? `${REPO_RELEASES_URL}/tag/v${ghVer}`;
          assetUrl = this.pickAssetUrl(gh.assets ?? []);
        }
      }
    } catch { /* keep server-reported version if GitHub unreachable */ }

    if (!version) return null;
    return { version, releaseUrl: releaseUrl ?? `${REPO_RELEASES_URL}/tag/v${version}`, assetUrl };
  }

  private pickAssetUrl(assets: Array<{ name?: string; browser_download_url?: string }>): string | null {
    const ext = process.platform === "win32" ? ".exe" : process.platform === "linux" ? ".AppImage" : "";
    if (!ext) return null;
    const match = assets.find(a => a.name?.endsWith(ext) && a.browser_download_url);
    return match?.browser_download_url ?? null;
  }

  private async promptAndInstall(info: DesktopUpdateInfo): Promise<void> {
    if (this.busy) return;
    const canDirectInstall = this.supportsDirectInstall(info);
    const answer = await dialog.showMessageBox({
      type: "info",
      title: say("updateAvailableTitle", { version: info.version }),
      message: say("updateAvailableTitle", { version: info.version }),
      detail: say(canDirectInstall ? "updateInstallDetail" : "updateOpenDetail", { current: this.currentVersion, version: info.version }),
      buttons: [say(canDirectInstall ? "updateInstallNow" : "updateOpenRelease"), say("cancel")],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response !== 0) return;

    if (!canDirectInstall || !info.assetUrl) {
      await shell.openExternal(info.releaseUrl);
      return;
    }

    try {
      await this.runDirectInstall(info);
    } catch (error) {
      this.busy = false;
      const fallback = await dialog.showMessageBox({
        type: "error",
        title: say("appName"),
        message: say("updateInstallFailed", { reason: error instanceof Error ? error.message : String(error) }),
        buttons: [say("updateOpenRelease"), say("cancel")],
        defaultId: 0,
        cancelId: 1,
      });
      if (fallback.response === 0) await shell.openExternal(info.releaseUrl);
    }
  }

  private async runDirectInstall(info: DesktopUpdateInfo): Promise<void> {
    if (!info.assetUrl) throw new Error("No installer asset URL available");
    this.busy = true;
    const startedAt = this.progress.startedAt ?? Date.now();
    this.emitProgress("downloading", { targetVersion: info.version, startedAt, error: null });
    if (process.platform === "linux" && process.env.APPIMAGE) {
      const target = process.env.APPIMAGE;
      const staged = `${target}.new`;
      await this.downloadToFile(info.assetUrl, staged);
      this.emitProgress("installing", { bytesPerSec: null });
      await chmod(staged, 0o755);
      await rename(staged, target);
      this.onBeforeQuit();
      app.relaunch();
      app.exit(0);
      return;
    }
    if (process.platform === "win32") {
      const installer = join(app.getPath("temp"), `Jarvy-${info.version}-win-x64.exe`);
      await this.downloadToFile(info.assetUrl, installer);
      this.emitProgress("installing", { bytesPerSec: null });
      const openErr = await shell.openPath(installer);
      if (openErr) throw new Error(openErr);
      this.onBeforeQuit();
      app.quit();
      return;
    }
    this.busy = false;
    this.emitProgress("idle");
    await shell.openExternal(info.releaseUrl);
  }

  private async downloadToFile(url: string, dest: string): Promise<void> {
    const res = await fetch(url, {
      headers: { "User-Agent": `jarvy-desktop/${this.currentVersion}` },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const contentLen = Number(res.headers.get("content-length") ?? "0");
    const totalBytes = Number.isFinite(contentLen) && contentLen > 0 ? contentLen : null;
    let bytesReceived = 0;
    let lastEmit = 0;
    let lastBytes = 0;
    let lastSample = Date.now();
    let bytesPerSec: number | null = null;
    this.emitProgress("downloading", { bytesReceived: 0, totalBytes, bytesPerSec: null });

    const source = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
    source.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      const now = Date.now();
      if (now - lastEmit >= 200) {
        const dt = (now - lastSample) / 1000;
        if (dt >= 0.2) {
          const instant = (bytesReceived - lastBytes) / dt;
          bytesPerSec = bytesPerSec === null ? instant : bytesPerSec * 0.6 + instant * 0.4;
          lastBytes = bytesReceived;
          lastSample = now;
        }
        lastEmit = now;
        this.emitProgress("downloading", { bytesReceived, totalBytes, bytesPerSec: bytesPerSec ? Math.round(bytesPerSec) : null });
      }
    });

    try {
      await pipeline(source, createWriteStream(dest));
      this.emitProgress("verifying", { bytesReceived, totalBytes: totalBytes ?? bytesReceived, bytesPerSec: null });
      const st = await stat(dest);
      if (st.size < 1024 * 1024) throw new Error("Downloaded installer is unexpectedly small");
    } catch (err) {
      await rm(dest, { force: true }).catch(() => {});
      throw err;
    }
  }
}
