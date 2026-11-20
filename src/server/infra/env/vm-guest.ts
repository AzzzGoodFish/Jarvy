import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkEnvironment } from "../../shared/environment.js";
import { COMPUTER_CWD, parseListeningPorts } from "./docker.js";
import { execSsh, pipeFromSsh, pipeToSsh, sshEnvironment, type SshAccess } from "./ssh.js";
import { makeSeedIso } from "./vm-template.js";

/** Thin-provisioned disk capacities for each VM sandbox (A99): 64 GB OS disk + 64 GB `/workspace` disk. */
export const VM_OS_DISK_BYTES = 64 * 2 ** 30;
export const VM_WORKSPACE_DISK_BYTES = 64 * 2 ** 30;
const VM_SWAP_MB = 2048;

/** Parameters for building a Bot VM's NoCloud `seed.iso`. */
export interface BotSeedSpec {
  instanceId: string;
  hostname: string;
  hostPrivateKey: string;
  hostPublicKey: string;
  clientPublicKey: string;
  hostGatewayIp: string;
  hostName: string;
}

/** Builds a Bot VM's NoCloud `seed.iso`: injects fixed SSH host keys and Jarvy's client key (in `/etc/jarvy` so
 * mounting `/workspace` or editing `/workspace/.ssh` never locks Jarvy out), mounts `/dev/vdb` at `/workspace` (making
 * ext4 the first time), sets up a 2 GB swapfile, maps `host.docker.internal`, enables Docker, and marks readiness. */
export async function makeBotSeedIso(isoPath: string, spec: BotSeedSpec): Promise<void> {
  const initScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `grep -q '[[:space:]]${spec.hostName}$' /etc/hosts || printf '%s\\t%s\\n' '${spec.hostGatewayIp}' '${spec.hostName}' >> /etc/hosts`,
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
    "systemctl enable --now fstrim.timer || true",
    "touch /var/lib/jarvy-vm-ready",
    "",
  ].join("\n");

  const sshdConfig = [
    "PasswordAuthentication no",
    "PubkeyAuthentication yes",
    "AuthorizedKeysFile /etc/jarvy/%u_authorized_keys .ssh/authorized_keys",
    "",
  ].join("\n");

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

  await makeSeedIso(isoPath, userData, { "instance-id": spec.instanceId, "local-hostname": spec.hostname });
}

/** Builds the `SshAccess` descriptor for reaching a Bot's VM as user `bot`. */
export function vmSshAccess(runtime: string, alias: string, ip: string, hostKey: string, privateKey: string): SshAccess {
  return { host: ip, port: 22, user: "bot", runtime, alias, hostKeys: [hostKey], privateKey };
}

/** Opens a `WorkEnvironment` into a running Bot VM over SSH using `pi-env`, rooted at `/workspace`. */
export function vmEnvironment(id: string, access: SshAccess, onLog?: (text: string) => void): WorkEnvironment {
  return sshEnvironment(id, access, COMPUTER_CWD, `${COMPUTER_CWD}/temp`, onLog, "computer");
}

/** Polls SSH until the VM's cloud-init setup finishes (marker `/var/lib/jarvy-vm-ready` present). */
export async function waitForVmReady(access: SshAccess, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "timed out";
  while (Date.now() < deadline) {
    try {
      const ready = await execSsh(access, "test -f /var/lib/jarvy-vm-ready && echo ok", { timeoutMs: 10_000 });
      if (ready.trim() === "ok") return;
      lastError = "guest cloud-init still running";
    } catch (error) { lastError = (error as Error).message; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`VM did not finish booting within ${timeoutMs / 1000}s: ${lastError}`);
}

/** Ensures `/etc/hosts` in a running VM points `hostName` to `gatewayIp` (for VMs whose network gateway changed). */
export async function ensureVmHostEntry(access: SshAccess, hostName: string, gatewayIp: string): Promise<void> {
  const cmd = `sudo sh -c "grep -q '[[:space:]]${hostName}$' /etc/hosts || printf '%s\\t%s\\n' '${gatewayIp}' '${hostName}' >> /etc/hosts"`;
  await execSsh(access, cmd, { timeoutMs: 15_000 });
}

/** Imports existing files from the host Bot `workspace/` directory into the VM's `/workspace` disk (once, on creation). */
export async function importWorkspace(access: SshAccess, hostWorkspace: string): Promise<void> {
  const entries = await readdir(hostWorkspace).catch(() => [] as string[]);
  if (!entries.length) return;
  await pipeToSsh(access, "sudo tar -xf - -C /workspace && sudo chown -R bot:bot /workspace", "tar", ["-cf", "-", "-C", hostWorkspace, "."], 600_000);
}

/** Exports `/workspace` from the VM back to the host `workspace/` directory atomically via a sibling staging folder so
 * a transfer error never corrupts or wipes existing host files. */
export async function exportWorkspace(access: SshAccess, hostWorkspace: string): Promise<void> {
  const parent = dirname(hostWorkspace);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".workspace-export-"));
  const backup = `${hostWorkspace}.prev-${process.pid}-${Date.now().toString(36)}`;
  let movedOld = false;
  try {
    await pipeFromSsh(access, "sudo tar -cf - -C /workspace .", "tar", ["--no-same-owner", "-xf", "-", "-C", staging], 600_000);
    try { await rename(hostWorkspace, backup); movedOld = true; } catch { /* hostWorkspace did not exist */ }
    await rename(staging, hostWorkspace);
    if (movedOld) await rm(backup, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    if (movedOld) await rename(backup, hostWorkspace).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Best-effort TRIM inside the VM so freed ext4 blocks are returned to the host qcow2 files. */
export async function trimVmDisks(access: SshAccess): Promise<void> {
  await execSsh(access, "sudo fstrim -a 2>/dev/null || true", { timeoutMs: 120_000 });
}

/** Listening TCP ports inside the VM, read from `/proc/net/tcp*`. */
export async function vmListeningPorts(access: SshAccess): Promise<Map<number, { loopbackOnly: boolean }>> {
  const out = await execSsh(access, "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null", { timeoutMs: 15_000 });
  return parseListeningPorts(out);
}

const VM_USAGE_CMD = "cat /proc/meminfo; echo @; grep -c '^cpu[0-9]' /proc/stat; head -1 /proc/stat; sleep 1; echo @; head -1 /proc/stat; echo @; "
  + "df -B1 --output=used,size / /workspace 2>/dev/null | tail -n +2";

/** Live memory, CPU (percent of one core) and combined disk usage read inside the VM over SSH. */
export async function vmUsage(access: SshAccess): Promise<{ memory: number; cpu: number; disk?: { used: number; size: number } }> {
  const out = await execSsh(access, `sh -c "${VM_USAGE_CMD}"`, { timeoutMs: 20_000 });
  const [meminfo = "", before = "", after = "", disks = ""] = out.split(/^@$/m).map(part => part.trim());
  const kib = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(meminfo)?.[1] ?? NaN) * 1024;
  const memory = kib("MemTotal") - kib("MemAvailable");
  if (!Number.isFinite(memory)) throw new Error(`no meminfo in the VM: ${out.slice(0, 200)}`);
  let used = 0, size = 0;
  for (const line of disks.split("\n").filter(Boolean)) {
    const [u, s] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(u) && Number.isFinite(s)) { used += u!; size += s!; }
  }
  return { memory, cpu: cpuPercent(before, after), ...(size > 0 ? { disk: { used, size } } : {}) };
}

/** CPU use between two `/proc/stat` samples a second apart, in percent of one core. */
export function cpuPercent(before: string, after: string): number {
  const [count = "", first = ""] = before.split("\n");
  const fields = (line: string) => line.trim().split(/\s+/).slice(1, 9).map(Number);
  const a = fields(first), b = fields(after), cpus = Number(count);
  if (a.length < 8 || b.length < 8 || !cpus) return 0;
  const total = b.reduce((sum, value, index) => sum + value - a[index]!, 0), idle = b[3]! - a[3]! + b[4]! - a[4]!;
  return total > 0 ? Math.max(0, (total - idle) / total * cpus * 100) : 0;
}
