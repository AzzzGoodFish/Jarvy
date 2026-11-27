import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { cpus as osCpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxNodeInfo } from "../contract/device.js";
import {
  pullDirectWorkspace, pushDirectWorkspace, readLocalWsMeta, scanDirectWorkspace,
} from "./workspace-direct.js";

/** Compute-node Docker sandbox manager for `jarvy client --sandbox` (A108).
 * Hosts on-demand isolated containers with shared package caches, warm-pause + LRU reclamation,
 * direct S3 Pre-signed URL workspace sync, and strict container-IP allowlisting for TCP port tunnels. */

export interface SandboxHostOptions {
  /** Base client config directory (stores `workspaces/` and shared package `caches/`). */
  baseDir: string;
  /** Default container image when server doesn't specify one. */
  image?: string;
  maxContainers?: number;
  idlePauseMs?: number;
  idleReclaimMs?: number;
  log?: (text: string) => void;
  onStateChanged?: (info: SandboxNodeInfo) => void;
}

interface TrackedSandbox {
  botId: string;
  container: string;
  ip: string;
  lastUsedAt: number;
  activeChannels: number;
  pinned: boolean;
  state: "running" | "paused" | "stopped";
}

function dockerExec(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout.trim());
    const line = stderr.trim().split("\n").filter(Boolean).at(-1) || err.message;
    reject(new Error(line));
  }));
}

export class SandboxHost {
  private readonly workspacesDir: string;
  private readonly cachesDir: string;
  private readonly maxContainers: number;
  private readonly idlePauseMs: number;
  private readonly idleReclaimMs: number;
  private readonly log: (text: string) => void;
  private readonly tracked = new Map<string, TrackedSandbox>(); // container -> tracked
  private readonly ownedIps = new Map<string, string>(); // container -> ip
  private daemonDir = "";
  private resolvedImage = "";
  private capacity = { cpus: osCpus().length, memory: totalmem() };
  private dockerReady = false;
  private reaper: NodeJS.Timeout | null = null;

  constructor(private readonly options: SandboxHostOptions) {
    this.workspacesDir = join(options.baseDir, "workspaces");
    this.cachesDir = join(options.baseDir, "caches");
    this.maxContainers = Math.max(1, options.maxContainers ?? 8);
    this.idlePauseMs = Math.max(60_000, options.idlePauseMs ?? 30 * 60_000);
    this.idleReclaimMs = Math.max(this.idlePauseMs, options.idleReclaimMs ?? 24 * 60 * 60_000);
    this.log = options.log ?? (text => console.log(`[sandbox-node] ${text}`));
  }

  /** Probes Docker, resolves default image, prepares cache directories, and starts idle reaper. */
  async probe(daemonBinaryPath: string): Promise<SandboxNodeInfo> {
    this.daemonDir = dirname(daemonBinaryPath);
    try {
      await dockerExec(["version", "--format", "{{.Server.Version}}"], 10_000);
      const info = (await dockerExec(["info", "--format", "{{.NCPU}} {{.MemTotal}}"], 10_000)).split(" ").map(Number);
      if (info[0] && info[1]) this.capacity = { cpus: info[0], memory: info[1] };
      this.resolvedImage = await this.pickDefaultImage();
      this.dockerReady = true;
      await this.prepareCaches();
      this.startReaper();
    } catch (error) {
      this.dockerReady = false;
      this.log(`Docker unavailable for --sandbox mode: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.info();
  }

  info(): SandboxNodeInfo {
    let active = 0;
    for (const item of this.tracked.values()) if (item.state === "running") active++;
    return {
      docker: this.dockerReady,
      cpus: this.capacity.cpus,
      memory: this.capacity.memory,
      image: this.resolvedImage,
      activeContainers: active,
      maxContainers: this.maxContainers,
    };
  }

  /** Security guard: returns true ONLY if `host` is an IP of a sandbox container managed by this node. */
  isAllowedTunnelHost(host: string): boolean {
    for (const ip of this.ownedIps.values()) if (ip && ip === host) return true;
    return false;
  }

  markChannel(container: string, delta: 1 | -1): void {
    const item = this.tracked.get(container);
    if (!item) return;
    item.activeChannels = Math.max(0, item.activeChannels + delta);
    item.lastUsedAt = Date.now();
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
  }

  async handleRpc(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.dockerReady && op.startsWith("sandbox_")) {
      throw new Error("Docker is not available on this compute node");
    }
    switch (op) {
      case "sandbox_ensure": return this.ensure(params);
      case "sandbox_stop": return this.stopContainer(String(params.container ?? ""));
      case "sandbox_pause": return this.pauseContainer(String(params.container ?? ""));
      case "sandbox_remove": return this.removeContainer(String(params.container ?? ""), Boolean(params.removeWorkspace), String(params.botId ?? ""));
      case "sandbox_stats": return this.stats(String(params.container ?? ""));
      case "workspace_push_plan": return this.workspacePlan(String(params.botId ?? ""));
      case "workspace_push_exec": return this.workspacePush(params);
      case "workspace_pull": return this.workspacePull(params);
      default: throw new Error(`Unknown compute RPC: ${op}`);
    }
  }

  private workspaceDir(botId: string): string {
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(botId)) throw new Error("Invalid botId");
    return join(this.workspacesDir, botId);
  }
  private workspaceMetaPath(botId: string): string {
    return join(this.workspacesDir, `${botId}.meta.json`);
  }

  private async ensure(params: Record<string, unknown>) {
    const botId = String(params.botId ?? "");
    const container = String(params.container ?? `jarvy-node-${botId.slice(0, 12)}`);
    if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(container)) throw new Error("Invalid container name");
    const wsDir = this.workspaceDir(botId);
    await mkdir(wsDir, { recursive: true, mode: 0o700 });
    const image = typeof params.image === "string" && params.image ? params.image : this.resolvedImage;
    const limits = params.limits && typeof params.limits === "object" ? params.limits as { memory?: number | null; cpus?: number | null } : {};

    const state = await this.inspectState(container);
    if (state === "paused") {
      await dockerExec(["unpause", container]);
    } else if (state === "stopped") {
      await this.evictIfFull(container);
      await dockerExec(["start", container]);
    } else if (state === "missing") {
      await this.evictIfFull(container);
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      await dockerExec([
        "run", "-d", "--name", container, "--init",
        "--user", `${uid}:${gid}`, "--shm-size", "1g",
        "--label", "jarvy.compute=1", "--label", `jarvy.bot=${botId}`,
        ...(limits.memory ? ["--memory", String(limits.memory), "--memory-swap", String(limits.memory)] : []),
        ...(limits.cpus ? ["--cpus", String(limits.cpus)] : []),
        "-v", `${wsDir}:/workspace`,
        "-v", `${this.daemonDir}:/opt/jarvy:ro`,
        "-v", `${join(this.cachesDir, "npm")}:/var/cache/jarvy/npm`,
        "-v", `${join(this.cachesDir, "pip")}:/var/cache/jarvy/pip`,
        "-v", `${join(this.cachesDir, "uv")}:/var/cache/jarvy/uv`,
        "-v", `${join(this.cachesDir, "cargo")}:/var/cache/jarvy/cargo`,
        "-e", "HOME=/workspace",
        "-e", "NPM_CONFIG_CACHE=/var/cache/jarvy/npm",
        "-e", "PIP_CACHE_DIR=/var/cache/jarvy/pip",
        "-e", "UV_CACHE_DIR=/var/cache/jarvy/uv",
        "-e", "CARGO_HOME=/var/cache/jarvy/cargo",
        "-w", "/workspace",
        image, "sleep", "infinity",
      ], 120_000);
    }

    const ip = await this.inspectIp(container);
    this.ownedIps.set(container, ip);
    const existing = this.tracked.get(container);
    this.tracked.set(container, {
      botId, container, ip, lastUsedAt: Date.now(),
      activeChannels: existing?.activeChannels ?? 0,
      pinned: Boolean(params.pinned ?? existing?.pinned),
      state: "running",
    });
    this.options.onStateChanged?.(this.info());
    const meta = await readLocalWsMeta(this.workspaceMetaPath(botId));
    return { state: "running", container, ip, image, workspaceRev: meta?.rev ?? 0 };
  }

  private async stopContainer(container: string) {
    if (!container) return { ok: true };
    await dockerExec(["stop", "-t", "5", container]).catch(() => {});
    const item = this.tracked.get(container);
    if (item) { item.state = "stopped"; item.ip = ""; }
    this.ownedIps.delete(container);
    this.options.onStateChanged?.(this.info());
    return { ok: true, state: "stopped" };
  }

  private async pauseContainer(container: string) {
    if (!container) return { ok: true };
    await dockerExec(["pause", container]).catch(() => {});
    const item = this.tracked.get(container);
    if (item) item.state = "paused";
    this.options.onStateChanged?.(this.info());
    return { ok: true, state: "paused" };
  }

  private async removeContainer(container: string, removeWorkspace: boolean, botId: string) {
    if (container) await dockerExec(["rm", "-f", container]).catch(() => {});
    this.tracked.delete(container);
    this.ownedIps.delete(container);
    if (removeWorkspace && botId) {
      await rm(this.workspaceDir(botId), { recursive: true, force: true }).catch(() => {});
      await rm(this.workspaceMetaPath(botId), { force: true }).catch(() => {});
    }
    this.options.onStateChanged?.(this.info());
    return { ok: true };
  }

  private async stats(container: string) {
    const state = await this.inspectState(container);
    if (state !== "running") return { state, ip: "", cpu: 0, memory: 0, listening: [] };
    const ip = await this.inspectIp(container);
    this.ownedIps.set(container, ip);
    const listening = await this.inspectListeningPorts(container).catch(() => []);
    return { state, ip, cpu: 0, memory: 0, listening };
  }

  private async workspacePlan(botId: string) {
    const { files, digest } = await scanDirectWorkspace(this.workspaceDir(botId));
    const meta = await readLocalWsMeta(this.workspaceMetaPath(botId));
    return { digest, localRev: meta?.rev ?? 0, files };
  }

  private async workspacePush(params: Record<string, unknown>) {
    const botId = String(params.botId ?? "");
    return pushDirectWorkspace({
      wsDir: this.workspaceDir(botId),
      metaPath: this.workspaceMetaPath(botId),
      botId,
      rev: Number(params.rev),
      manifestKey: String(params.manifestKey),
      manifestUrl: String(params.manifestUrl),
      blobPuts: (params.blobPuts ?? {}) as Record<string, { key: string; url: string }>,
      keyBase64: String(params.keyBase64),
    });
  }

  private async workspacePull(params: Record<string, unknown>) {
    const botId = String(params.botId ?? "");
    return pullDirectWorkspace({
      wsDir: this.workspaceDir(botId),
      metaPath: this.workspaceMetaPath(botId),
      rev: Number(params.rev),
      manifestKey: String(params.manifestKey),
      manifestUrl: String(params.manifestUrl),
      blobGets: (params.blobGets ?? {}) as Record<string, { key: string; url: string }>,
      keyBase64: String(params.keyBase64),
    });
  }

  private async evictIfFull(exceptContainer: string): Promise<void> {
    const running = [...this.tracked.values()].filter(t => t.state === "running" && t.container !== exceptContainer);
    if (running.length < this.maxContainers) return;
    running.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const candidate of running) {
      if (candidate.activeChannels > 0 || candidate.pinned) continue;
      this.log(`LRU pausing idle sandbox ${candidate.container} to make room`);
      await this.pauseContainer(candidate.container);
      return;
    }
  }

  private startReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = setInterval(() => void this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const item of [...this.tracked.values()]) {
      if (item.activeChannels > 0 || item.pinned) continue;
      const idle = now - item.lastUsedAt;
      if (item.state === "running" && idle >= this.idlePauseMs) {
        const ports = await this.inspectListeningPorts(item.container).catch(() => []);
        if (ports.length > 0) continue; // Keep alive while serving published ports
        this.log(`warm-pausing idle sandbox ${item.container}`);
        await this.pauseContainer(item.container);
      } else if (item.state === "paused" && idle >= this.idleReclaimMs) {
        this.log(`reclaiming long-idle sandbox ${item.container} (workspace preserved)`);
        await this.removeContainer(item.container, false, item.botId);
      }
    }
  }

  private async pickDefaultImage(): Promise<string> {
    if (this.options.image) return this.options.image;
    if (process.env.JARVY_SANDBOX_IMAGE) return process.env.JARVY_SANDBOX_IMAGE;
    const built = await dockerExec(["images", "--filter", "label=jarvy.computer=1", "--format", "{{.Repository}}:{{.Tag}}"]).catch(() => "");
    const firstBuilt = built.split("\n").map(s => s.trim()).find(Boolean);
    return firstBuilt || "ubuntu:24.04";
  }

  private async prepareCaches(): Promise<void> {
    await mkdir(this.workspacesDir, { recursive: true, mode: 0o700 });
    for (const sub of ["npm", "pip", "uv", "cargo"]) {
      await mkdir(join(this.cachesDir, sub), { recursive: true, mode: 0o777 });
    }
  }

  private async inspectState(container: string): Promise<"running" | "paused" | "stopped" | "missing"> {
    try {
      const out = await dockerExec(["inspect", "--format", "{{.State.Status}}", container]);
      if (out === "running") return "running";
      if (out === "paused") return "paused";
      return "stopped";
    } catch {
      return "missing";
    }
  }

  private async inspectIp(container: string): Promise<string> {
    const out = await dockerExec(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container]).catch(() => "");
    return out.split(/\s+/).find(Boolean) ?? "";
  }

  private async inspectListeningPorts(container: string): Promise<Array<{ port: number; loopbackOnly: boolean }>> {
    const raw = await dockerExec(["exec", container, "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true"], 10_000);
    const byPort = new Map<number, { loopbackOnly: boolean }>();
    for (const line of raw.split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== "0A") continue;
      const [addrHex, portHex] = (cols[1] ?? "").split(":");
      const port = Number.parseInt(portHex ?? "", 16);
      if (!port) continue;
      const loopback = addrHex === "0100007F" || addrHex === "00000000000000000000000001000000";
      const prev = byPort.get(port);
      byPort.set(port, { loopbackOnly: prev ? prev.loopbackOnly && loopback : loopback });
    }
    return [...byPort.entries()].map(([port, v]) => ({ port, loopbackOnly: v.loopbackOnly }));
  }
}
