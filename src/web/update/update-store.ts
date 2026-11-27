import { useSyncExternalStore } from "react";
import type { DesktopUpdateStatus } from "../../contract/desktop";
import { compareSemver, type UpdateStatus } from "../../contract/update";
import { api } from "../api";
import { desktop } from "../desktop";
import { errorText } from "../errors";

export type UpdateMode = "server" | "desktop" | "both";
export type UpdateJobStage =
  | "server_installing"
  | "server_restarting"
  | "server_reconnecting"
  | "desktop_downloading"
  | "desktop_verifying"
  | "desktop_installing"
  | "completed"
  | "error";

export interface UpdateJob {
  mode: UpdateMode;
  targetVersion: string;
  beforeServerVersion: string | null;
  startedAt: number;
  stage: UpdateJobStage;
  detail: string | null;
  error: string | null;
  bytesReceived: number;
  totalBytes: number | null;
  bytesPerSec: number | null;
  dismissed: boolean;
}

export interface UpdateStoreSnapshot {
  server: UpdateStatus | null;
  desktop: DesktopUpdateStatus | null;
  checking: boolean;
  notice: string | null;
  error: string | null;
  job: UpdateJob | null;
  now: number;
}

interface PersistedIntent {
  mode: UpdateMode;
  targetVersion: string;
  beforeServerVersion: string | null;
  startedAt: number;
}

const STORAGE_KEY = "jarvy:update-job";

function loadIntent(): PersistedIntent | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedIntent>;
    if (!parsed.targetVersion || !parsed.mode || !parsed.startedAt) return null;
    // Discard stale intents older than 15 minutes.
    if (Date.now() - parsed.startedAt > 15 * 60_000) { clearIntent(); return null; }
    return {
      mode: parsed.mode,
      targetVersion: parsed.targetVersion,
      beforeServerVersion: parsed.beforeServerVersion ?? null,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

function saveIntent(intent: PersistedIntent): void {
  try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(intent)); } catch { /* ignore */ }
}

function clearIntent(): void {
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

class UpdateStore {
  private snap: UpdateStoreSnapshot = {
    server: null, desktop: null, checking: false, notice: null, error: null, job: null, now: Date.now(),
  };
  private listeners = new Set<() => void>();
  private initialized = false;
  private pollTimer: number | null = null;
  private tickTimer: number | null = null;
  private reloadTimer: number | null = null;
  private unsubscribeDesktop: (() => void) | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): UpdateStoreSnapshot => this.snap;

  private emit(patch: Partial<UpdateStoreSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.syncTimers();
    for (const listener of this.listeners) listener();
  }

  private updateJob(patch: Partial<UpdateJob>): void {
    if (!this.snap.job) return;
    this.emit({ job: { ...this.snap.job, ...patch } });
  }

  private isJobActive(job: UpdateJob | null): boolean {
    return !!job && job.stage !== "completed" && job.stage !== "error";
  }

  private syncTimers(): void {
    const active = this.isJobActive(this.snap.job);
    if (active && this.tickTimer === null) {
      this.tickTimer = window.setInterval(() => {
        this.snap = { ...this.snap, now: Date.now() };
        for (const listener of this.listeners) listener();
      }, 1000);
    } else if (!active && this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (active && this.pollTimer === null) {
      this.pollTimer = window.setInterval(() => { void this.pollActiveJob(); }, 1200);
    } else if (!active && this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    const client = desktop();
    if (client?.onUpdateProgress) {
      this.unsubscribeDesktop = client.onUpdateProgress(status => this.handleDesktopStatus(status));
    }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const client = desktop();
    const [srv, desk] = await Promise.all([
      api.updateStatus().catch(() => null),
      client?.updateStatus ? client.updateStatus().catch(() => null) : Promise.resolve(null),
    ]);
    if (srv || desk) {
      this.emit({
        ...(srv ? { server: srv } : {}),
        ...(desk ? { desktop: desk } : {}),
      });
    }
    this.reconcileFromRuntime(srv, desk);
  }

  private reconcileFromRuntime(srv: UpdateStatus | null, desk: DesktopUpdateStatus | null): void {
    const intent = loadIntent();
    if (this.isJobActive(this.snap.job)) return;

    // 1. Re-attach to an in-progress desktop download/install (e.g. reopened Settings or reloaded page).
    const dp = desk?.progress;
    if (dp && (dp.phase === "downloading" || dp.phase === "verifying" || dp.phase === "installing")) {
      const target = dp.targetVersion ?? desk?.latestVersion ?? intent?.targetVersion ?? "";
      if (target) {
        this.emit({
          job: {
            mode: intent?.mode ?? "desktop",
            targetVersion: target,
            beforeServerVersion: intent?.beforeServerVersion ?? srv?.currentVersion ?? null,
            startedAt: dp.startedAt ?? intent?.startedAt ?? Date.now(),
            stage: dp.phase === "downloading" ? "desktop_downloading" : dp.phase === "verifying" ? "desktop_verifying" : "desktop_installing",
            detail: null,
            error: null,
            bytesReceived: dp.bytesReceived,
            totalBytes: dp.totalBytes,
            bytesPerSec: dp.bytesPerSec,
            dismissed: false,
          },
        });
        return;
      }
    }

    // 2. Re-attach to an in-progress server install/restart.
    if (srv?.updating || srv?.progress?.phase === "installing" || srv?.progress?.phase === "restarting") {
      const target = srv.progress?.targetVersion ?? srv.latestVersion ?? intent?.targetVersion ?? srv.currentVersion;
      this.emit({
        job: {
          mode: intent?.mode ?? "server",
          targetVersion: target,
          beforeServerVersion: intent?.beforeServerVersion ?? srv.currentVersion,
          startedAt: srv.progress?.startedAt ?? intent?.startedAt ?? Date.now(),
          stage: srv.progress?.phase === "restarting" ? "server_restarting" : "server_installing",
          detail: srv.progress?.detail ?? null,
          error: null,
          bytesReceived: 0,
          totalBytes: null,
          bytesPerSec: null,
          dismissed: false,
        },
      });
      return;
    }

    // 3. Resume post-reload intent once the server came back on the target version.
    if (intent && srv && compareSemver(srv.currentVersion, intent.targetVersion) >= 0) {
      const client = desktop();
      const desktopStillBehind = intent.mode === "both" && Boolean(client?.installUpdate)
        && compareSemver(intent.targetVersion, desk?.currentVersion ?? client?.version ?? "0.0.0") > 0;
      if (desktopStillBehind) {
        this.emit({
          job: {
            mode: "both",
            targetVersion: intent.targetVersion,
            beforeServerVersion: intent.beforeServerVersion,
            startedAt: intent.startedAt,
            stage: "desktop_downloading",
            detail: null,
            error: null,
            bytesReceived: 0,
            totalBytes: null,
            bytesPerSec: null,
            dismissed: false,
          },
        });
        void this.launchDesktopStep();
      } else {
        clearIntent();
        this.emit({
          job: {
            mode: intent.mode,
            targetVersion: srv.currentVersion,
            beforeServerVersion: intent.beforeServerVersion,
            startedAt: intent.startedAt,
            stage: "completed",
            detail: null,
            error: null,
            bytesReceived: 0,
            totalBytes: null,
            bytesPerSec: null,
            dismissed: false,
          },
        });
      }
    }
  }

  private handleDesktopStatus(desk: DesktopUpdateStatus): void {
    const patch: Partial<UpdateStoreSnapshot> = { desktop: desk };
    const dp = desk.progress;
    const job = this.snap.job;
    if (dp && job && (job.mode === "desktop" || job.mode === "both") && job.stage.startsWith("desktop_")) {
      if (dp.phase === "downloading" || dp.phase === "verifying" || dp.phase === "installing") {
        patch.job = {
          ...job,
          stage: dp.phase === "downloading" ? "desktop_downloading" : dp.phase === "verifying" ? "desktop_verifying" : "desktop_installing",
          bytesReceived: dp.bytesReceived,
          totalBytes: dp.totalBytes,
          bytesPerSec: dp.bytesPerSec,
          error: null,
        };
      } else if (dp.phase === "error") {
        clearIntent();
        patch.job = { ...job, stage: "error", error: dp.error ?? "Desktop update failed", bytesPerSec: null };
      }
    }
    this.emit(patch);
  }

  async checkNow(): Promise<void> {
    if (this.snap.checking) return;
    const client = desktop();
    this.emit({ checking: true, notice: null, error: null });
    try {
      const [srv, desk] = await Promise.all([
        api.checkForUpdate(),
        client?.checkUpdate ? client.checkUpdate().catch(() => null) : Promise.resolve(null),
      ]);
      this.emit({
        server: srv,
        ...(desk ? { desktop: desk } : {}),
        checking: false,
        error: srv.lastError && !desk?.updateAvailable ? srv.lastError : null,
      });
    } catch (reason) {
      this.emit({ checking: false, error: errorText(reason) });
    }
  }

  async startUpdate(mode: UpdateMode, targetVersion: string): Promise<void> {
    if (this.isJobActive(this.snap.job)) return;
    if (this.reloadTimer !== null) { window.clearTimeout(this.reloadTimer); this.reloadTimer = null; }
    const beforeServer = this.snap.server?.currentVersion ?? null;
    const startedAt = Date.now();
    saveIntent({ mode, targetVersion, beforeServerVersion: beforeServer, startedAt });
    this.emit({
      error: null,
      notice: null,
      job: {
        mode,
        targetVersion,
        beforeServerVersion: beforeServer,
        startedAt,
        stage: mode === "desktop" ? "desktop_downloading" : "server_installing",
        detail: null,
        error: null,
        bytesReceived: 0,
        totalBytes: null,
        bytesPerSec: null,
        dismissed: false,
      },
    });

    if (mode === "desktop") {
      await this.launchDesktopStep();
      return;
    }

    try {
      const res = await api.applyUpdate();
      if (!res.started) {
        clearIntent();
        this.updateJob({ stage: "completed", targetVersion: res.targetVersion });
        return;
      }
      this.updateJob({ targetVersion: res.targetVersion });
    } catch (reason) {
      clearIntent();
      this.updateJob({ stage: "error", error: errorText(reason) });
    }
  }

  private async launchDesktopStep(): Promise<void> {
    const client = desktop();
    if (!client?.installUpdate) {
      clearIntent();
      this.updateJob({ stage: "error", error: "Desktop updater unavailable" });
      return;
    }
    this.updateJob({ stage: "desktop_downloading", error: null, bytesReceived: 0, totalBytes: null, bytesPerSec: null });
    try {
      const res = await client.installUpdate();
      if (!res.started) {
        clearIntent();
        this.updateJob({ stage: "error", error: res.error || "Desktop update failed" });
      }
    } catch (reason) {
      clearIntent();
      this.updateJob({ stage: "error", error: errorText(reason) });
    }
  }

  private async pollActiveJob(): Promise<void> {
    const job = this.snap.job;
    if (!job || !this.isJobActive(job)) return;

    if (job.stage.startsWith("desktop_")) {
      const client = desktop();
      if (client?.updateStatus) {
        const desk = await client.updateStatus().catch(() => null);
        if (desk) this.handleDesktopStatus(desk);
      }
      return;
    }

    try {
      const srv = await api.updateStatus();
      const prev = this.snap.job;
      if (!prev) return;
      this.emit({ server: srv });

      const phase = srv.progress?.phase;
      const versionUpgraded = compareSemver(srv.currentVersion, prev.targetVersion) >= 0
        || (prev.beforeServerVersion !== null && compareSemver(srv.currentVersion, prev.beforeServerVersion) > 0);

      if (versionUpgraded && !srv.updating) {
        if (prev.mode === "both" && desktop()?.installUpdate) {
          await this.launchDesktopStep();
        } else {
          clearIntent();
          this.updateJob({ stage: "completed", targetVersion: srv.currentVersion, detail: null });
          this.reloadTimer = window.setTimeout(() => { window.location.reload(); }, 1800);
        }
        return;
      }

      if (phase === "error") {
        clearIntent();
        this.updateJob({ stage: "error", error: srv.progress?.detail ?? srv.lastError ?? "Server update failed" });
        return;
      }

      if (phase === "restarting") {
        this.updateJob({ stage: "server_restarting", detail: null });
      } else if (srv.updating || phase === "installing") {
        this.updateJob({ stage: "server_installing", detail: srv.progress?.detail ?? prev.detail });
      } else if (prev.stage === "server_restarting" || prev.stage === "server_reconnecting") {
        // Server came back up without incrementing version (e.g. interrupted).
        clearIntent();
        this.updateJob({ stage: "error", error: srv.lastError ?? "Server restarted without applying the update" });
      }
    } catch {
      // Expected 503 / connection refused while the server restarts gracefully.
      const prev = this.snap.job;
      if (prev && (prev.stage === "server_installing" || prev.stage === "server_restarting")) {
        this.updateJob({ stage: "server_reconnecting", detail: null });
      }
    }
  }

  dismissJob(): void {
    if (this.reloadTimer !== null) { window.clearTimeout(this.reloadTimer); this.reloadTimer = null; }
    if (!this.isJobActive(this.snap.job)) {
      clearIntent();
      this.emit({ job: null });
    } else if (this.snap.job) {
      this.updateJob({ dismissed: true });
    }
  }

  reloadPage(): void {
    clearIntent();
    window.location.reload();
  }

  dispose(): void {
    this.unsubscribeDesktop?.();
    this.unsubscribeDesktop = null;
  }
}

export const updateStore = new UpdateStore();

export function useUpdateStore(): UpdateStoreSnapshot {
  return useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot, updateStore.getSnapshot);
}
