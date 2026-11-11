import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { VmProblemReason } from "../../../contract/environment.js";
import { KATA_RUNTIME, docker } from "./docker.js";

/** VM sandboxes (A85): containers Docker runs with Kata, each in a small virtual machine of its own, with Docker
 * inside on a disk of the Bot's. Kata is the owner's to install (its release unpacked to /opt/kata, and its shim
 * linked onto the PATH); Docker needs no other setting. */

/** How large a VM sandbox's Docker disk may grow: a sparse file, so this machine gives only what is written. */
export const VM_DISK_SIZE = 64 * 2 ** 30;

/** Why VM sandboxes can't be used here, with what was said; null when a trial VM ran. */
export interface VmProblem { reason: VmProblemReason; detail: string }
/** Runs a trial VM from `image` (about four seconds) and tells apart why one won't run: no Kata shim for Docker, no
 * KVM on this machine, KVM held by another hypervisor (VirtualBox takes the processor's virtualization for itself
 * while one of its machines runs, and Kata then times out starting QEMU), or something else. */
export async function vmProblem(image: string): Promise<VmProblem | null> {
  if (!existsSync("/dev/kvm")) return { reason: "no_kvm", detail: "this machine has no /dev/kvm" };
  try {
    await docker(["run", "--rm", "--runtime", KATA_RUNTIME, "--memory", "512m", "--entrypoint", "true", image], 120_000);
    return null;
  } catch (error) {
    const said = (error as Error).message;
    if (/binary not installed|containerd-shim-kata|unknown runtime|executable file not found/i.test(said)) return { reason: "no_kata", detail: said };
    if (/resource busy|KVM_CREATE_VM/i.test(said) || /QMP ready/i.test(said) && otherHypervisor()) return { reason: "busy", detail: said };
    if (/\/dev\/kvm|kvm/i.test(said)) return { reason: "no_kvm", detail: said };
    return { reason: "failed", detail: said };
  }
}
/** Whether VirtualBox's driver is loaded; Kata fails without saying why while one of its machines runs. */
function otherHypervisor(): boolean {
  try { return /^vboxdrv /m.test(readFileSync("/proc/modules", "utf8")); }
  catch { return false; }
}

/** Makes a Bot's Docker disk when it has none: an empty sparse file, formatted inside the VM on its first start. */
export async function createDisk(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; });
  if (!file) return;
  try { await file.truncate(VM_DISK_SIZE); } finally { await file.close(); }
}
/** Removes a Bot's Docker disk: its images, containers and volumes go with it. */
export async function removeDisk(path: string): Promise<void> { await rm(path, { force: true }); }
/** Starts Docker in a running VM sandbox (DOCKER_UP), as root; it returns once Docker answers. */
export async function dockerUp(container: string): Promise<void> {
  await docker(["exec", "-u", "root", container, "/usr/local/bin/jarvy-docker-up"], 90_000);
}
/** Gives this machine back the blocks of a VM's Docker disk that Docker no longer uses: from now on as it frees them
 * (`discard`), and those freed before (`fstrim`). Without it the sparse file only grows, towards 64 GB, whatever is
 * deleted inside. Done here, not in DOCKER_UP, so it reaches VMs made from an image built before it. */
export async function trimDisk(container: string): Promise<void> {
  await docker(["exec", "-u", "root", container, "sh", "-c", "mount -o remount,discard /var/lib/docker && fstrim /var/lib/docker"], 120_000);
}
/** The name servers this machine asks, for a VM sandbox to ask them itself: on a network of its own (A74) a container
 * resolves names through Docker's server at 127.0.0.11, which a VM's own loopback doesn't have. As Docker does for its
 * default bridge, systemd-resolved's upstream servers stand in for its local stub, and public ones for none. */
export function hostResolvers(): string[] {
  for (const file of ["/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"]) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const servers = [...text.matchAll(/^\s*nameserver\s+(\S+)/gm)].map(match => match[1]!)
      .filter(address => isIP(address) && !address.startsWith("127.") && address !== "::1" && !address.toLowerCase().startsWith("fe80:"));
    if (servers.length) return servers.slice(0, 3);
  }
  return ["8.8.8.8", "8.8.4.4"];
}
/** Points a running VM sandbox at these name servers. Docker writes its /etc/resolv.conf again at each start, so this
 * is redone after each. */
export async function useResolvers(container: string, servers: readonly string[]): Promise<void> {
  await docker(["exec", "-u", "root", container, "sh", "-c", `printf 'nameserver %s\\n' ${servers.join(" ")} > /etc/resolv.conf`], 30_000);
}

/** What a running VM sandbox uses, read inside it (A85): Docker's own count is only its container's cgroup in the VM,
 * file cache included, and not what else runs there, such as the containers Docker in it starts. Memory is the VM's
 * total less what it has available; CPU, over a second, is in percent of one core, as `docker stats` gives it; the
 * Docker disk's use once it is mounted. */
export async function vmUsage(container: string): Promise<{ memory: number; cpu: number; disk?: { used: number; size: number } }> {
  const out = await docker(["exec", container, "sh", "-c", VM_USAGE], 30_000);
  const [meminfo = "", before = "", after = "", disk = ""] = out.split(/^@$/m).map(part => part.trim());
  const kib = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(meminfo)?.[1] ?? NaN) * 1024;
  const memory = kib("MemTotal") - kib("MemAvailable");
  if (!Number.isFinite(memory)) throw new Error(`no meminfo in the VM: ${out.slice(0, 200)}`);
  const used = Number(disk);
  return { memory, cpu: cpuPercent(before, after), ...(disk && Number.isFinite(used) ? { disk: { used, size: VM_DISK_SIZE } } : {}) };
}
/** /proc/meminfo, the CPU line of /proc/stat a second apart with the number of CPUs, and the bytes used on the Docker
 * disk when it is mounted, parted by `@`. */
const VM_USAGE = "cat /proc/meminfo; echo @; grep -c '^cpu[0-9]' /proc/stat; head -1 /proc/stat; sleep 1; echo @; head -1 /proc/stat; echo @; "
  + "if mountpoint -q /var/lib/docker; then df -B1 --output=used /var/lib/docker | tail -1; fi";
/** CPU use between two samples of /proc/stat's first line, after the count of CPUs: the share of all CPUs' time that
 * wasn't idle or waiting for I/O, times the CPUs, in percent of one core. */
export function cpuPercent(before: string, after: string): number {
  const [count = "", first = ""] = before.split("\n");
  const fields = (line: string) => line.trim().split(/\s+/).slice(1, 9).map(Number);
  const a = fields(first), b = fields(after), cpus = Number(count);
  if (a.length < 8 || b.length < 8 || !cpus) return 0;
  const total = b.reduce((sum, value, index) => sum + value - a[index]!, 0), idle = b[3]! - a[3]! + b[4]! - a[4]!;
  return total > 0 ? Math.max(0, (total - idle) / total * cpus * 100) : 0;
}
/** What a running VM sandbox takes of this machine: its hypervisor's resident memory, which keeps what the VM once used
 * since its kernel fills spare memory with cache, and what its Docker disk's sparse file holds. Null for what can't be
 * read: a hypervisor run inside Kata's shim has no process of its own. */
export async function vmHostUse(container: string, disk: string): Promise<{ memory: number | null; disk: number | null }> {
  const [memory, held] = await Promise.all([hypervisorMemory(container).catch(() => null), stat(disk).then(file => file.blocks * 512).catch(() => null)]);
  return { memory, disk: held };
}
const HYPERVISOR = /(qemu-system|cloud-hypervisor|firecracker)[^/]*$/;
/** The hypervisor process of each VM sandbox, found once: its command line names the container's ID. */
const hypervisors = new Map<string, string>();
async function hypervisorMemory(container: string): Promise<number | null> {
  const id = await docker(["inspect", "--format", "{{.Id}}", container]);
  const runs = async (pid: string) => {
    const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    return command.includes(id) && HYPERVISOR.test(command.split("\0")[0] ?? "");
  };
  let pid = hypervisors.get(container);
  if (!pid || !await runs(pid)) {
    pid = undefined; hypervisors.delete(container);
    for (const entry of await readdir("/proc")) if (/^\d+$/.test(entry) && await runs(entry)) { pid = entry; hypervisors.set(container, entry); break; }
  }
  if (!pid) return null;
  const kib = /^VmRSS:\s+(\d+)\s+kB/m.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1];
  return kib ? Number(kib) * 1024 : null;
}
