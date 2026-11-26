import type { Duplex } from "node:stream";
import type { SandboxNodeInfo } from "../../../contract/device.js";
import type { ComputerCapacity, ComputerUsage } from "../../../contract/environment.js";
import type { CloudSync } from "../../infra/cloud/sync.js";
import { COMPUTER_CWD } from "../../infra/env/docker.js";
import type { DeviceLinks } from "../../infra/env/device-link.js";
import { openRemoteContainerFs } from "../../infra/env/env-fs.js";
import { openRemoteContainerPty } from "../../infra/env/terminal.js";
import type { EnvironmentRecord, ExecOptions, WorkEnvironment } from "../../shared/environment.js";
import type { EnvironmentFs } from "../../shared/env-files.js";
import type { PtyHandle, PtyOpenOptions } from "../../shared/terminal.js";
import { RuntimeFault } from "../../shared/runtime.js";
import { computerLimits } from "./computer-vm.js";

/** Remote on-demand sandbox compute pool scheduler (A108).
 * Dispatches container sandboxes to connected `jarvy client --sandbox` nodes over WSS, coordinates
 * direct compute-node ↔ S3 Pre-signed URL workspace sync, opens remote PTYs/Files, and tunnels published ports. */

export interface RemotePlacement {
  botId: string;
  deviceId: string;
  deviceName: string;
  container: string;
  ip: string;
  image: string;
  state: "running" | "stopped";
}

interface EnsureReply {
  state: "running";
  container: string;
  ip: string;
  image: string;
  workspaceRev: number;
}

interface StatsReply {
  state: "running" | "paused" | "stopped" | "missing";
  ip: string;
  cpu: number;
  memory: number;
  listening: Array<{ port: number; loopbackOnly: boolean }>;
}

interface PushPlanReply {
  digest: string;
  localRev: number;
  files: Array<{ path: string; sha256: string; size: number; mode: number; mtimeMs: number }>;
}

export interface ComputePoolDeps {
  links: DeviceLinks;
  cloud: CloudSync | null;
  botName: (botId: string) => string;
  changed: () => void;
  onEnvironmentClosed?: (environmentId: string) => void;
  log?: (text: string) => void;
}

const PUSH_DEBOUNCE_MS = 3_000;

export class ComputePool {
  private readonly placements = new Map<string, RemotePlacement>(); // botId -> active remote placement
  private readonly connections = new Map<string, WorkEnvironment>();
  private readonly ensuring = new Map<string, Promise<RemotePlacement>>();
  private readonly pushTimers = new Map<string, NodeJS.Timeout>();
  private readonly log: (text: string) => void;

  constructor(private readonly deps: ComputePoolDeps) {
    this.log = deps.log ?? (text => console.log(`[compute-pool] ${text}`));
  }

  /** Online compute nodes currently capable of hosting remote Docker sandboxes. */
  nodes(): Array<{ id: string; name: string; sandbox: SandboxNodeInfo }> {
    return this.deps.links.sandboxNodes();
  }

  hasOnlineNode(): boolean {
    return this.nodes().length > 0;
  }

  placement(botId: string): RemotePlacement | null {
    const current = this.placements.get(botId);
    if (!current) return null;
    if (!this.deps.links.online(current.deviceId) || this.deps.links.paused(current.deviceId)) {
      return { ...current, state: "stopped" };
    }
    return current;
  }

  /** Called when a compute node disconnects or pauses: tears down cached connections on that node. */
  nodeDisconnected(deviceId: string): void {
    let anyChanged = false;
    for (const [botId, p] of [...this.placements.entries()]) {
      if (p.deviceId !== deviceId) continue;
      this.placements.delete(botId);
      const env = this.connections.get(botId);
      this.connections.delete(botId);
      void env?.close().catch(() => {});
      anyChanged = true;
    }
    if (anyChanged) this.deps.changed();
  }

  /** Picks the best online compute node (sticky to existing placement, else lowest utilization). */
  pickNode(botId: string, preferredDeviceId?: string): { id: string; name: string; sandbox: SandboxNodeInfo } | null {
    const online = this.nodes();
    if (!online.length) return null;
    const existing = this.placements.get(botId);
    if (existing) {
      const same = online.find(n => n.id === existing.deviceId);
      if (same) return same;
    }
    if (preferredDeviceId) {
      const pref = online.find(n => n.id === preferredDeviceId);
      if (pref) return pref;
    }
    online.sort((a, b) => {
      const loadA = a.sandbox.activeContainers / Math.max(1, a.sandbox.maxContainers);
      const loadB = b.sandbox.activeContainers / Math.max(1, b.sandbox.maxContainers);
      if (loadA !== loadB) return loadA - loadB;
      return b.sandbox.memory - a.sandbox.memory;
    });
    return online[0]!;
  }

  /** Ensures a Bot's container is running on a remote compute node, syncing latest workspace from S3 first. */
  async ensure(botId: string, record: EnvironmentRecord): Promise<RemotePlacement> {
    const inflight = this.ensuring.get(botId);
    if (inflight) return inflight;
    const task = this.doEnsure(botId, record).finally(() => this.ensuring.delete(botId));
    this.ensuring.set(botId, task);
    return task;
  }

  private async doEnsure(botId: string, record: EnvironmentRecord): Promise<RemotePlacement> {
    const node = this.pickNode(botId, record.spec.computeNode);
    if (!node) throw new RuntimeFault("docker_unavailable", "No local Docker or online compute node is available.", 503);

    // Hydrate workspace directly from S3 into compute node BEFORE container runs commands.
    await this.pullWorkspaceToNode(botId, node.id);

    const container = `jarvy-node-${botId.slice(0, 12)}`;
    const limits = computerLimits(record);
    const reply = await this.deps.links.callRpc<EnsureReply>(node.id, "sandbox_ensure", {
      botId, container, limits,
    }, 120_000);

    const placement: RemotePlacement = {
      botId,
      deviceId: node.id,
      deviceName: node.name,
      container: reply.container,
      ip: reply.ip,
      image: reply.image,
      state: "running",
    };
    this.placements.set(botId, placement);
    this.deps.changed();
    this.log(`sandbox ${container} for bot ${botId.slice(0, 8)} running on compute node "${node.name}" (${reply.ip})`);
    return placement;
  }

  /** Returns a `WorkEnvironment` executing inside the remote compute node's container, with automatic workspace sync. */
  environment(botId: string, record: EnvironmentRecord): WorkEnvironment {
    const getEnv = async (): Promise<{ placement: RemotePlacement; env: WorkEnvironment }> => {
      const placement = await this.ensure(botId, record);
      let env = this.connections.get(botId);
      if (!env) {
        env = this.deps.links.remoteContainerEnvironment(
          placement.deviceId,
          record.id,
          placement.container,
          this.deps.botName(botId),
          COMPUTER_CWD,
          text => this.log(`[${botId.slice(0, 8)}@${placement.deviceName}] ${text.trim()}`),
        );
        this.connections.set(botId, env);
      }
      return { placement, env };
    };

    const runExec = async (command: string | readonly string[], options: ExecOptions) => {
      const { placement, env } = await getEnv();
      await this.pullWorkspaceToNode(botId, placement.deviceId);
      try {
        return await env.exec(command, options);
      } finally {
        this.scheduleWorkspacePush(botId, placement.deviceId);
      }
    };

    const run = async <T>(op: (env: WorkEnvironment) => Promise<T>, mutates = false): Promise<T> => {
      const { placement, env } = await getEnv();
      try {
        return await op(env);
      } finally {
        if (mutates) this.scheduleWorkspacePush(botId, placement.deviceId);
      }
    };

    return {
      id: record.id,
      kind: "computer",
      local: false,
      cwd: COMPUTER_CWD,
      exec: runExec,
      readFile: path => run(env => env.readFile(path)),
      head: (path, bytes) => run(env => env.head(path, bytes)),
      readRange: (path, offset, length) => run(env => env.readRange(path, offset, length)),
      writeFile: (path, content) => run(env => env.writeFile(path, content), true),
      appendFile: (path, content) => run(env => env.appendFile(path, content), true),
      mkdir: path => run(env => env.mkdir(path), true),
      exists: path => run(env => env.exists(path)),
      fileSize: path => run(env => env.fileSize(path)),
      close: () => this.disconnect(botId),
    };
  }

  async openPty(botId: string, record: EnvironmentRecord, options: PtyOpenOptions): Promise<{ pty: PtyHandle; cwd: string; shell: "bash" }> {
    const placement = await this.ensure(botId, record);
    const cwd = options.cwd && options.cwd.startsWith("/") ? options.cwd : COMPUTER_CWD;
    const pty = await openRemoteContainerPty(
      this.deps.links, placement.deviceId, placement.container,
      { ...options, cwd, argv: ["/bin/bash", "-l"] },
      text => this.log(`[pty ${botId.slice(0, 8)}@${placement.deviceName}] ${text.trim()}`),
    );
    return { pty, cwd, shell: "bash" };
  }

  openFs(botId: string, record: EnvironmentRecord): EnvironmentFs | null {
    const p = this.placement(botId);
    if (!p || p.state !== "running") return null;
    return openRemoteContainerFs(
      this.deps.links, p.deviceId, record.id, p.container, COMPUTER_CWD, COMPUTER_CWD,
      text => this.log(`[fs ${botId.slice(0, 8)}@${p.deviceName}] ${text.trim()}`),
    );
  }

  /** Returns a tunneled upstream for `PublishedPorts` when this Bot's sandbox runs on a remote compute node. */
  portTarget(botId: string, port: number): { host: string; port: number; connect: () => Duplex } | null {
    const p = this.placement(botId);
    if (!p || p.state !== "running" || !p.ip) return null;
    return {
      host: p.ip,
      port,
      connect: () => this.deps.links.openTcpTunnel(p.deviceId, p.ip, port),
    };
  }

  async listening(botId: string): Promise<Map<number, { loopbackOnly: boolean }> | null> {
    const p = this.placement(botId);
    if (!p || p.state !== "running") return null;
    const stats = await this.deps.links.callRpc<StatsReply>(p.deviceId, "sandbox_stats", { container: p.container }, 15_000).catch(() => null);
    if (!stats || stats.state !== "running") return null;
    if (stats.ip && stats.ip !== p.ip) p.ip = stats.ip;
    return new Map(stats.listening.map(item => [item.port, { loopbackOnly: item.loopbackOnly }]));
  }

  /** Live CPU/RAM usage for a Bot sandbox running on a remote compute node (A109). */
  async usage(botId: string): Promise<ComputerUsage | null> {
    const p = this.placement(botId);
    if (!p || p.state !== "running") return null;
    const stats = await this.deps.links.callRpc<StatsReply>(p.deviceId, "sandbox_stats", { container: p.container }, 15_000).catch(() => null);
    if (!stats || stats.state !== "running") return null;
    return { cpu: stats.cpu, memory: stats.memory };
  }

  /** Capacity of the compute node hosting `botId` (or the best online candidate node, A109). */
  capacity(botId: string, preferredDeviceId?: string): ComputerCapacity | null {
    const node = this.pickNode(botId, preferredDeviceId);
    return node ? { cpus: node.sandbox.cpus, memory: node.sandbox.memory } : null;
  }

  /** Pushes workspace to S3, removes the ephemeral container on the compute node, and clears placement (A109). */
  async reclaim(botId: string): Promise<boolean> {
    return this.reset(botId);
  }

  /** Clears a stopped placement so changing preferred compute node takes effect on the next start (A109). */
  clearStoppedPlacement(botId: string): void {
    const p = this.placements.get(botId);
    if (p && p.state !== "running") this.placements.delete(botId);
  }

  /** Hydrates local `/workspace` from last-synced S3 snapshot when offline browsing is requested (A109). */
  async hydrateWorkspace(botId: string): Promise<void> {
    await this.deps.cloud?.ensureLocalWorkspace(botId).catch(() => {});
  }

  async stop(botId: string): Promise<boolean> {
    const p = this.placements.get(botId);
    if (!p) return false;
    await this.pushWorkspaceNow(botId, p.deviceId).catch(() => {});
    await this.disconnect(botId);
    await this.deps.links.callRpc(p.deviceId, "sandbox_stop", { container: p.container }, 30_000).catch(() => {});
    p.state = "stopped";
    this.deps.changed();
    return true;
  }

  async reset(botId: string): Promise<boolean> {
    const p = this.placements.get(botId);
    if (!p) return false;
    await this.pushWorkspaceNow(botId, p.deviceId).catch(() => {});
    await this.disconnect(botId);
    await this.deps.links.callRpc(p.deviceId, "sandbox_remove", { botId, container: p.container, removeWorkspace: false }, 30_000).catch(() => {});
    this.placements.delete(botId);
    this.deps.changed();
    return true;
  }

  async remove(botId: string, keepFiles: boolean): Promise<boolean> {
    const p = this.placements.get(botId);
    if (!p) return false;
    if (keepFiles) await this.pushWorkspaceNow(botId, p.deviceId).catch(() => {});
    await this.disconnect(botId);
    await this.deps.links.callRpc(p.deviceId, "sandbox_remove", { botId, container: p.container, removeWorkspace: !keepFiles }, 30_000).catch(() => {});
    this.placements.delete(botId);
    this.deps.changed();
    return true;
  }

  /** Forces an immediate direct compute-node → S3 workspace push if cloud storage is active. */
  async pushWorkspaceNow(botId: string, deviceId?: string): Promise<boolean> {
    const timer = this.pushTimers.get(botId);
    if (timer) { clearTimeout(timer); this.pushTimers.delete(botId); }
    const cloud = this.deps.cloud;
    const targetDevice = deviceId ?? this.placements.get(botId)?.deviceId;
    if (!cloud || !targetDevice || !this.deps.links.online(targetDevice)) return false;

    const plan = await this.deps.links.callRpc<PushPlanReply>(targetDevice, "workspace_push_plan", { botId }, 30_000);
    const signed = await cloud.presignWorkspacePush(botId, plan.digest, plan.files);
    if (!signed || !signed.changed) return false;

    const pushed = await this.deps.links.callRpc<{ rev: number; digest: string; uploadedBlobs: number }>(targetDevice, "workspace_push_exec", {
      botId,
      rev: signed.rev,
      manifestKey: signed.manifestKey,
      manifestUrl: signed.manifestUrl,
      blobPuts: signed.blobPuts,
      keyBase64: signed.keyBase64,
    }, 120_000);

    await cloud.commitRemoteWorkspacePush(botId, {
      rev: pushed.rev,
      digest: pushed.digest,
      manifestKey: signed.manifestKey,
      uploadedHashes: Object.keys(signed.blobPuts),
    });
    this.log(`direct S3 workspace push for ${botId.slice(0, 8)}: rev=${pushed.rev}, blobs=${pushed.uploadedBlobs}`);
    return true;
  }

  async close(): Promise<void> {
    for (const timer of this.pushTimers.values()) clearTimeout(timer);
    this.pushTimers.clear();
    await Promise.all([...this.connections.keys()].map(botId => this.disconnect(botId)));
  }

  private async pullWorkspaceToNode(botId: string, deviceId: string): Promise<void> {
    const cloud = this.deps.cloud;
    if (!cloud) return;
    const signed = await cloud.presignWorkspacePull(botId);
    if (!signed) return;
    const res = await this.deps.links.callRpc<{ skipped: boolean; rev: number; recovered: number }>(deviceId, "workspace_pull", {
      botId,
      rev: signed.rev,
      manifestKey: signed.manifestKey,
      manifestUrl: signed.manifestUrl,
      blobGets: signed.blobGets,
      keyBase64: signed.keyBase64,
    }, 120_000);
    if (!res.skipped) this.log(`direct S3 workspace pull for ${botId.slice(0, 8)} → node: rev=${res.rev}${res.recovered ? `, recovered=${res.recovered}` : ""}`);
  }

  private scheduleWorkspacePush(botId: string, deviceId: string): void {
    if (!this.deps.cloud) return;
    const prev = this.pushTimers.get(botId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.pushTimers.delete(botId);
      void this.pushWorkspaceNow(botId, deviceId).catch(error => {
        this.log(`background workspace push failed for ${botId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, PUSH_DEBOUNCE_MS);
    timer.unref();
    this.pushTimers.set(botId, timer);
  }

  private async disconnect(botId: string): Promise<void> {
    const env = this.connections.get(botId);
    this.connections.delete(botId);
    await env?.close().catch(() => {});
  }
}
