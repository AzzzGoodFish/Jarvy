import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defineDomain, domainIp, domainMac, domainState, domainXml, ensurePool, ensureVmNetwork, execCmd,
  libvirtProblem, qemuMemory, randomMac, shutdownDomain, startDomain, undefineDomain, updateDomainSize,
  virsh, volAllocation, volCreateQcow2, volDelete, volExists, volList, volPath, volUploadFile, type VmNetwork,
} from "../server/infra/env/libvirt.js";

/** Compute-node KVM/libvirt VM manager for `jarvy client --sandbox` (A110).
 * Runs full Linux VM sandboxes on physical compute nodes with KVM/libvirt, reuses existing local Jarvy VM
 * base templates when present, syncs `/workspace` to the compute node's staging folder for direct S3
 * Pre-signed URL transfer, and bridges `pi-env` over SSH into the existing WSS `open` channel. */

const VM_OS_DISK_BYTES = 64 * 2 ** 30;
const VM_WORKSPACE_DISK_BYTES = 64 * 2 ** 30;
const VM_DEFAULT_MEMORY = 4 * 2 ** 30;
const VM_DEFAULT_CPUS = 2;
const VM_SWAP_MB = 2048;
const VM_PI_ENV_PATH = "/usr/local/bin/jarvy-pi-env";
const HOST_NAME = "host.docker.internal";

interface VmAuth {
  privateKey: string;
  publicKey: string;
  hostKey: string;
  ip?: string;
}

interface TrackedVm {
  botId: string;
  domain: string;
  ip: string;
  keyPath: string;
  knownHostsPath: string;
  lastUsedAt: number;
  activeChannels: number;
  state: "running" | "stopped";
}

export interface VmProbeResult {
  available: boolean;
  reason?: string;
  image?: string;
}

const vmVolumes = (name: string) => ({
  os: `${name}-os.qcow2`,
  workspace: `${name}-workspace.qcow2`,
  seed: `${name}-seed.iso`,
});

export class VmHost {
  private readonly tag: string;
  private readonly pool: string;
  private readonly vmsDir: string;
  private readonly tracked = new Map<string, TrackedVm>();
  private infra: Promise<VmNetwork> | null = null;
  private daemonPath = "";
  private daemonSha = "";
  private ready = false;
  private reason: string | undefined;
  private imageTag = "";

  constructor(
    private readonly baseDir: string,
    private readonly log: (text: string) => void,
    private readonly onChanged: () => void,
  ) {
    this.tag = createHash("sha256").update(baseDir).digest("hex").slice(0, 6);
    this.pool = `jarvy-c${this.tag}`;
    this.vmsDir = join(baseDir, "vms");
  }

  get available(): boolean { return this.ready; }
  get unavailableReason(): string | undefined { return this.reason; }
  get image(): string { return this.imageTag; }
  get activeCount(): number {
    let n = 0;
    for (const item of this.tracked.values()) if (item.state === "running") n++;
    return n;
  }

  isOwnedIp(ip: string): boolean {
    for (const item of this.tracked.values()) if (item.ip && item.ip === ip) return true;
    return false;
  }

  markChannel(domain: string, delta: 1 | -1): void {
    const item = this.tracked.get(domain);
    if (!item) return;
    item.activeChannels = Math.max(0, item.activeChannels + delta);
    item.lastUsedAt = Date.now();
  }

  async probe(daemonBinaryPath: string): Promise<VmProbeResult> {
    this.daemonPath = daemonBinaryPath;
    if (daemonBinaryPath && existsSync(daemonBinaryPath)) {
      const bytes = await readFile(daemonBinaryPath).catch(() => null);
      if (bytes) this.daemonSha = createHash("sha256").update(bytes).digest("hex");
    }
    try {
      const problem = await libvirtProblem();
      if (problem) {
        this.ready = false;
        this.reason = problem.reason;
        this.imageTag = "";
        return { available: false, reason: problem.reason };
      }
      this.ready = true;
      this.reason = undefined;
      const existing = await this.findExistingTemplate();
      this.imageTag = existing ? `ubuntu-24.04:${existing.tag}` : "ubuntu-24.04:kvm";
      await mkdir(this.vmsDir, { recursive: true, mode: 0o700 });
      return { available: true, image: this.imageTag };
    } catch (error) {
      this.ready = false;
      this.reason = "failed";
      this.log(`KVM/libvirt probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return { available: false, reason: "failed" };
    }
  }

  /** Spawns `/usr/local/bin/jarvy-pi-env <args>` inside a running managed VM over SSH for `Connector.run()`. */
  spawnDaemon(domain: string, args: string[]): ChildProcess {
    const item = this.tracked.get(domain);
    if (!item || item.state !== "running" || !item.ip) {
      throw new Error(`VM ${domain} is not running on this compute node`);
    }
    const quoted = [VM_PI_ENV_PATH, ...args].map(shellQuote).join(" ");
    return spawn("ssh", [...this.sshBaseArgs(item), "-T", `bot@${item.ip}`, quoted], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  async ensure(params: {
    botId: string;
    domain: string;
    limits?: { memory?: number | null; cpus?: number | null };
    localWsDir: string;
    importWorkspace?: boolean;
  }): Promise<{ state: "running"; container: string; ip: string; image: string }> {
    if (!this.ready) throw new Error(`KVM/libvirt is not available on this compute node (${this.reason ?? "unavailable"})`);
    const { botId, domain, localWsDir } = params;
    if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(domain)) throw new Error("Invalid VM domain name");
    const network = await this.ensureInfra();
    const baseBackingPath = await this.ensureBaseBackingPath();

    const memoryMiB = Math.max(1024, Math.round((params.limits?.memory ?? VM_DEFAULT_MEMORY) / 2 ** 20));
    const vcpus = Math.max(1, Math.round(params.limits?.cpus ?? VM_DEFAULT_CPUS));
    const vols = vmVolumes(domain);

    const wsExists = await volExists(this.pool, vols.workspace);
    const workspaceVolPath = wsExists ? await volPath(this.pool, vols.workspace) : await volCreateQcow2(this.pool, vols.workspace, VM_WORKSPACE_DISK_BYTES);
    const osExists = await volExists(this.pool, vols.os);
    const osVolPath = osExists ? await volPath(this.pool, vols.os) : await volCreateQcow2(this.pool, vols.os, VM_OS_DISK_BYTES, baseBackingPath);

    const vmDir = join(this.vmsDir, domain);
    await mkdir(vmDir, { recursive: true, mode: 0o700 });
    const authPath = join(vmDir, "auth.json");
    let auth = await this.readAuth(authPath);
    const needSeed = !auth || !osExists || !(await volExists(this.pool, vols.seed));
    let seedVolPath: string;
    if (needSeed) {
      const clientKey = auth ? { privateKey: auth.privateKey, publicKey: auth.publicKey } : await generateEd25519(vmDir, domain);
      const hostKey = await generateEd25519(vmDir, `${domain}-host`);
      const bareHost = hostKey.publicKey.split(" ").slice(0, 2).join(" ");
      auth = { privateKey: clientKey.privateKey, publicKey: clientKey.publicKey, hostKey: bareHost };
      await writeFile(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
      seedVolPath = await this.uploadSeedIso(vols.seed, {
        instanceId: `${domain}-${Date.now().toString(36)}`,
        hostname: domain,
        hostPrivateKey: hostKey.privateKey,
        hostPublicKey: hostKey.publicKey,
        clientPublicKey: clientKey.publicKey,
        hostGatewayIp: network.gateway,
      });
    } else {
      seedVolPath = await volPath(this.pool, vols.seed);
    }

    const state = await domainState(domain);
    let mac: string | undefined;
    if (state === "missing") {
      mac = randomMac();
      await defineDomain(domainXml({ name: domain, memoryMiB, vcpus, osVolPath, workspaceVolPath, seedVolPath, network: network.name, filter: network.filter, mac }));
      await startDomain(domain);
    } else {
      mac = (await domainMac(domain)) ?? undefined;
      if (state === "stopped") await startDomain(domain);
    }

    const ip = await this.waitIp(domain, network.name, mac, 120_000);
    const keyPath = join(vmDir, "id_ed25519");
    const knownHostsPath = join(vmDir, "known_hosts");
    await writeFile(keyPath, auth!.privateKey, { mode: 0o600 });
    await writeFile(knownHostsPath, `${ip} ${auth!.hostKey}\n`, { mode: 0o600 });

    const item: TrackedVm = {
      botId, domain, ip, keyPath, knownHostsPath, lastUsedAt: Date.now(),
      activeChannels: this.tracked.get(domain)?.activeChannels ?? 0,
      state: "running",
    };
    this.tracked.set(domain, item);

    await this.waitReady(item, 180_000);
    await this.ensureGuestPiEnv(item);
    if (!wsExists || params.importWorkspace) {
      await this.syncIn(domain, localWsDir);
    }
    this.onChanged();
    return { state: "running", container: domain, ip, image: this.imageTag };
  }

  /** Imports local staging directory into the running VM's `/workspace`. */
  async syncIn(domain: string, localWsDir: string): Promise<void> {
    const item = this.tracked.get(domain);
    if (!item || item.state !== "running") return;
    const entries = await readdir(localWsDir).catch(() => []);
    if (!entries.length) return;
    await pipeToSsh(this.sshBaseArgs(item), `bot@${item.ip}`, "sudo tar -xf - -C /workspace && sudo chown -R bot:bot /workspace", "tar", ["-cf", "-", "-C", localWsDir, "."], 600_000);
  }

  /** Exports `/workspace` from the running VM into `localWsDir` atomically for direct S3 Pre-signed URL upload. */
  async syncOut(domain: string, localWsDir: string): Promise<boolean> {
    const item = this.tracked.get(domain);
    if (!item || item.state !== "running") return false;
    const parent = dirname(localWsDir);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(parent, ".vm-ws-export-"));
    const backup = `${localWsDir}.prev-${process.pid}-${Date.now().toString(36)}`;
    let movedOld = false;
    try {
      await pipeFromSsh(this.sshBaseArgs(item), `bot@${item.ip}`, "sudo tar -cf - -C /workspace .", "tar", ["--no-same-owner", "-xf", "-", "-C", staging], 600_000);
      try { await rename(localWsDir, backup); movedOld = true; } catch { /* did not exist */ }
      await rename(staging, localWsDir);
      if (movedOld) await rm(backup, { recursive: true, force: true }).catch(() => {});
      return true;
    } catch (error) {
      if (movedOld) await rename(backup, localWsDir).catch(() => {});
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async stop(domain: string): Promise<{ ok: true; state: "stopped" }> {
    if (!domain) return { ok: true, state: "stopped" };
    await shutdownDomain(domain).catch(() => {});
    const item = this.tracked.get(domain);
    if (item) { item.state = "stopped"; item.ip = ""; }
    this.onChanged();
    return { ok: true, state: "stopped" };
  }

  async remove(domain: string, removeWorkspace: boolean, localWsDir?: string): Promise<{ ok: true }> {
    if (!domain) return { ok: true };
    const vols = vmVolumes(domain);
    if (!removeWorkspace && localWsDir) {
      await this.syncOut(domain, localWsDir).catch(() => {});
    }
    await shutdownDomain(domain).catch(() => {});
    await undefineDomain(domain).catch(() => {});
    await volDelete(this.pool, vols.os).catch(() => {});
    await volDelete(this.pool, vols.seed).catch(() => {});
    if (removeWorkspace) {
      await volDelete(this.pool, vols.workspace).catch(() => {});
      await rm(join(this.vmsDir, domain), { recursive: true, force: true }).catch(() => {});
    }
    this.tracked.delete(domain);
    this.onChanged();
    return { ok: true };
  }

  async resize(domain: string, limits: { memory?: number | null; cpus?: number | null }): Promise<{ ok: true }> {
    if (!domain || await domainState(domain) === "missing") return { ok: true };
    const memoryMiB = Math.max(1024, Math.round((limits.memory ?? VM_DEFAULT_MEMORY) / 2 ** 20));
    const vcpus = Math.max(1, Math.round(limits.cpus ?? VM_DEFAULT_CPUS));
    await updateDomainSize(domain, memoryMiB, vcpus);
    return { ok: true };
  }

  async stats(domain: string): Promise<{
    state: "running" | "stopped" | "missing";
    ip: string;
    cpu: number;
    memory: number;
    disk?: { used: number; size: number };
    host?: { memory: number | null; disk: number | null };
    listening: Array<{ port: number; loopbackOnly: boolean }>;
  }> {
    const st = await domainState(domain).catch(() => "missing" as const);
    const item = this.tracked.get(domain);
    if (st !== "running" || !item?.ip) {
      return { state: st === "running" ? "running" : st === "stopped" ? "stopped" : "missing", ip: "", cpu: 0, memory: 0, listening: [] };
    }
    const cmd = "cat /proc/meminfo; echo @; grep -c '^cpu[0-9]' /proc/stat; head -1 /proc/stat; sleep 1; echo @; head -1 /proc/stat; echo @; df -B1 --output=used,size / /workspace 2>/dev/null | tail -n +2; echo @; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true";
    const out = await this.execSsh(item, `sh -c ${shellQuote(cmd)}`, 20_000).catch(() => "");
    const [meminfo = "", before = "", after = "", disks = "", tcp = ""] = out.split(/^@$/m).map(p => p.trim());
    const kib = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(meminfo)?.[1] ?? NaN) * 1024;
    const memory = Number.isFinite(kib("MemTotal") - kib("MemAvailable")) ? Math.max(0, kib("MemTotal") - kib("MemAvailable")) : 0;
    let used = 0, size = 0;
    for (const line of disks.split("\n").filter(Boolean)) {
      const [u, s] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(u) && Number.isFinite(s)) { used += u!; size += s!; }
    }
    const vols = vmVolumes(domain);
    const [hostMem, osAlloc, wsAlloc] = await Promise.all([
      qemuMemory(domain).catch(() => null),
      volAllocation(this.pool, vols.os).catch(() => null),
      volAllocation(this.pool, vols.workspace).catch(() => null),
    ]);
    const hostDisk = osAlloc === null && wsAlloc === null ? null : (osAlloc ?? 0) + (wsAlloc ?? 0);
    return {
      state: "running",
      ip: item.ip,
      cpu: cpuPercent(before, after),
      memory,
      ...(size > 0 ? { disk: { used, size } } : {}),
      host: { memory: hostMem, disk: hostDisk },
      listening: parseProcTcp(tcp),
    };
  }

  private ensureInfra(): Promise<VmNetwork> {
    this.infra ??= (async () => {
      await ensurePool(this.pool);
      return ensureVmNetwork(`c${this.tag}`);
    })().catch(error => { this.infra = null; throw error; });
    return this.infra;
  }

  /** Reuses any existing Jarvy `base-*.qcow2` backing template on this host to avoid slow rebuilds. */
  private async findExistingTemplate(): Promise<{ path: string; tag: string } | null> {
    const poolsRaw = await virsh(["pool-list", "--name"], 10_000).catch(() => "");
    const pools = poolsRaw.split("\n").map(s => s.trim()).filter(Boolean);
    const ordered = [this.pool, ...pools.filter(p => p !== this.pool && p.startsWith("jarvy-")), ...pools.filter(p => p !== this.pool && !p.startsWith("jarvy-"))];
    for (const pool of ordered) {
      const vols = await volList(pool).catch(() => []);
      const base = vols.find(v => /^base-[a-f0-9]+\.qcow2$/.test(v));
      if (!base) continue;
      const fullPath = await volPath(pool, base).catch(() => "");
      if (fullPath) {
        const tag = /^base-([a-f0-9]+)\.qcow2$/.exec(base)?.[1] ?? "kvm";
        return { path: fullPath, tag };
      }
    }
    return null;
  }

  private async ensureBaseBackingPath(): Promise<string> {
    const found = await this.findExistingTemplate();
    if (found) {
      this.imageTag = `ubuntu-24.04:${found.tag}`;
      return found.path;
    }
    throw new Error(
      "No Jarvy VM base template (base-*.qcow2) found in libvirt pools on this compute node. " +
      "Initialize one via a local Jarvy VM build or place base-<tag>.qcow2 into /var/lib/libvirt/images/" + this.pool + ".",
    );
  }

  private async uploadSeedIso(seedVol: string, spec: {
    instanceId: string; hostname: string; hostPrivateKey: string; hostPublicKey: string; clientPublicKey: string; hostGatewayIp: string;
  }): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "jarvy-cvm-seed-"));
    try {
      const initScript = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `grep -q '[[:space:]]${HOST_NAME}$' /etc/hosts || printf '%s\\t%s\\n' '${spec.hostGatewayIp}' '${HOST_NAME}' >> /etc/hosts`,
        "if [ -b /dev/vdb ]; then",
        "  blkid /dev/vdb >/dev/null 2>&1 || mkfs.ext4 -q -F -L workspace /dev/vdb",
        "  mkdir -p /workspace",
        "  grep -q ' /workspace ' /etc/fstab || echo '/dev/vdb /workspace ext4 defaults,discard,nofail 0 2' >> /etc/fstab",
        "  mountpoint -q /workspace || mount -o discard /dev/vdb /workspace",
        "fi",
        "mkdir -p /workspace /workspace/temp /home/bot/.npm-global/bin /home/bot/.npm-global/lib",
        "chown bot:bot /workspace /workspace/temp",
        "chown -R bot:bot /home/bot",
        "if [ ! -f /swapfile ]; then",
        `  fallocate -l ${VM_SWAP_MB}M /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=${VM_SWAP_MB} status=none`,
        "  chmod 600 /swapfile && mkswap /swapfile >/dev/null",
        "  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab",
        "fi",
        "swapon -a || true",
        "systemctl enable --now docker ssh || true",
        "touch /var/lib/jarvy-vm-ready",
        "",
      ].join("\n");

      const sshdConfig = "PasswordAuthentication no\nPubkeyAuthentication yes\nAuthorizedKeysFile /etc/jarvy/%u_authorized_keys .ssh/authorized_keys\n";
      const userData = "#cloud-config\n" + JSON.stringify({
        manage_etc_hosts: false,
        ssh_pwauth: false,
        ssh_keys: { ed25519_private: spec.hostPrivateKey, ed25519_public: spec.hostPublicKey },
        write_files: [
          { path: "/etc/jarvy/bot_authorized_keys", permissions: "0644", content: `${spec.clientPublicKey.trim()}\n` },
          { path: "/etc/ssh/sshd_config.d/90-jarvy.conf", permissions: "0644", content: sshdConfig },
          { path: "/usr/local/sbin/jarvy-vm-init.sh", permissions: "0755", content: initScript },
        ],
        runcmd: [["/usr/local/sbin/jarvy-vm-init.sh"]],
      }) + "\n";

      const userFile = join(dir, "user-data"), metaFile = join(dir, "meta-data"), iso = join(dir, "seed.iso");
      await writeFile(userFile, userData, { mode: 0o600 });
      await writeFile(metaFile, `${JSON.stringify({ "instance-id": spec.instanceId, "local-hostname": spec.hostname })}\n`, { mode: 0o600 });
      await execCmd("cloud-localds", [iso, userFile, metaFile], 60_000);
      return await volUploadFile(this.pool, seedVol, iso, "raw");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async ensureGuestPiEnv(item: TrackedVm): Promise<void> {
    if (!this.daemonPath || !existsSync(this.daemonPath)) throw new Error("pi-env Linux daemon binary missing on compute node");
    const remoteSha = (await this.execSsh(item, `sha256sum ${VM_PI_ENV_PATH} 2>/dev/null | awk '{print $1}'`, 10_000).catch(() => "")).trim();
    if (this.daemonSha && remoteSha === this.daemonSha) return;
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", [...this.sshBaseArgs(item), "-T", `bot@${item.ip}`, `sudo tee ${VM_PI_ENV_PATH}.part >/dev/null && sudo chmod 755 ${VM_PI_ENV_PATH}.part && sudo mv -f ${VM_PI_ENV_PATH}.part ${VM_PI_ENV_PATH}`], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let errText = "";
      ssh.stderr.on("data", chunk => { errText += chunk.toString(); });
      ssh.on("error", reject);
      ssh.on("close", code => code === 0 ? resolve() : reject(new Error(`upload pi-env to VM failed (${code}): ${errText.trim()}`)));
      createReadStream(this.daemonPath).pipe(ssh.stdin);
    });
  }

  private async waitIp(domain: string, network: string, mac: string | undefined, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ip = await domainIp(domain, network, mac).catch(() => null);
      if (ip) return ip;
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error(`VM ${domain} did not acquire an IP address within ${timeoutMs / 1000}s`);
  }

  private async waitReady(item: TrackedVm, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "timed out";
    while (Date.now() < deadline) {
      try {
        const out = await this.execSsh(item, "test -f /var/lib/jarvy-vm-ready && echo ok", 10_000);
        if (out.trim() === "ok") return;
        lastErr = "cloud-init still running";
      } catch (error) {
        lastErr = error instanceof Error ? error.message : String(error);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error(`VM ${item.domain} did not finish booting within ${timeoutMs / 1000}s: ${lastErr}`);
  }

  private sshBaseArgs(item: TrackedVm): string[] {
    return [
      "-F", "/dev/null", "-i", item.keyPath,
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${item.knownHostsPath}`,
      "-o", "LogLevel=ERROR",
    ];
  }

  private execSsh(item: TrackedVm, command: string, timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => execFile("ssh", [...this.sshBaseArgs(item), "-T", `bot@${item.ip}`, command], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      reject(new Error(stderr.trim() || err.message));
    }));
  }

  private async readAuth(path: string): Promise<VmAuth | null> {
    return readFile(path, "utf8").then(t => JSON.parse(t) as VmAuth).catch(() => null);
  }
}

async function generateEd25519(dir: string, comment: string): Promise<{ privateKey: string; publicKey: string }> {
  const work = await mkdtemp(join(dir, "keygen-"));
  try {
    const keyFile = join(work, "key");
    await execCmd("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", keyFile], 15_000);
    await chmod(keyFile, 0o600);
    return { privateKey: await readFile(keyFile, "utf8"), publicKey: (await readFile(`${keyFile}.pub`, "utf8")).trim() };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function pipeToSsh(sshArgs: string[], target: string, remoteCmd: string, localProg: string, localArgs: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const local = spawn(localProg, localArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const ssh = spawn("ssh", [...sshArgs, "-T", target, remoteCmd], { stdio: ["pipe", "ignore", "pipe"] });
    let errText = "";
    const timer = setTimeout(() => { local.kill("SIGKILL"); ssh.kill("SIGKILL"); reject(new Error("VM workspace import timed out")); }, timeoutMs);
    local.stderr.on("data", c => { errText += c.toString(); });
    ssh.stderr.on("data", c => { errText += c.toString(); });
    local.stdout.pipe(ssh.stdin);
    let localCode: number | null = null, sshCode: number | null = null;
    const finish = () => {
      if (localCode === null || sshCode === null) return;
      clearTimeout(timer);
      if (localCode === 0 && sshCode === 0) resolve();
      else reject(new Error(`VM workspace import failed (local=${localCode}, ssh=${sshCode}): ${errText.trim()}`));
    };
    local.on("close", c => { localCode = c ?? 1; finish(); });
    ssh.on("close", c => { sshCode = c ?? 1; finish(); });
    local.on("error", e => { clearTimeout(timer); reject(e); });
    ssh.on("error", e => { clearTimeout(timer); reject(e); });
  });
}

function pipeFromSsh(sshArgs: string[], target: string, remoteCmd: string, localProg: string, localArgs: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", [...sshArgs, "-T", target, remoteCmd], { stdio: ["ignore", "pipe", "pipe"] });
    const local = spawn(localProg, localArgs, { stdio: ["pipe", "ignore", "pipe"] });
    let errText = "";
    const timer = setTimeout(() => { local.kill("SIGKILL"); ssh.kill("SIGKILL"); reject(new Error("VM workspace export timed out")); }, timeoutMs);
    ssh.stderr.on("data", c => { errText += c.toString(); });
    local.stderr.on("data", c => { errText += c.toString(); });
    ssh.stdout.pipe(local.stdin);
    let localCode: number | null = null, sshCode: number | null = null;
    const finish = () => {
      if (localCode === null || sshCode === null) return;
      clearTimeout(timer);
      if (localCode === 0 && sshCode === 0) resolve();
      else reject(new Error(`VM workspace export failed (ssh=${sshCode}, local=${localCode}): ${errText.trim()}`));
    };
    ssh.on("close", c => { sshCode = c ?? 1; finish(); });
    local.on("close", c => { localCode = c ?? 1; finish(); });
    ssh.on("error", e => { clearTimeout(timer); reject(e); });
    local.on("error", e => { clearTimeout(timer); reject(e); });
  });
}

function cpuPercent(before: string, after: string): number {
  const [count = "", first = ""] = before.split("\n");
  const fields = (line: string) => line.trim().split(/\s+/).slice(1, 9).map(Number);
  const a = fields(first), b = fields(after), cpus = Number(count);
  if (a.length < 8 || b.length < 8 || !cpus) return 0;
  const total = b.reduce((sum, value, index) => sum + value - a[index]!, 0), idle = b[3]! - a[3]! + b[4]! - a[4]!;
  return total > 0 ? Math.max(0, (total - idle) / total * cpus * 100) : 0;
}

function parseProcTcp(raw: string): Array<{ port: number; loopbackOnly: boolean }> {
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

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
