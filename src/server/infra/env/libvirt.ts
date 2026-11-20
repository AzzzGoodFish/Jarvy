import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { VmProblemReason } from "../../../contract/environment.js";
import type { Capacity, ContainerState } from "./docker.js";

/** System VM sandboxes (A99): full Linux virtual machines managed through libvirt (`qemu:///system`), each with a
 * thin-provisioned qcow2 OS disk (backed by a shared template), a dedicated qcow2 `/workspace` disk, and an isolated
 * NAT network with nwfilter rules. Runs as a non-root user in the `libvirt` group with zero root setup scripts. */
export const VIRSH_URI = "qemu:///system";
const POOL_ROOT = "/var/lib/libvirt/images";

/** Why VM sandboxes can't be used here, with what libvirt or the host said; null when libvirt + KVM are ready. */
export interface VmProblem { reason: VmProblemReason; detail: string }

/** A Jarvy-scoped libvirt NAT network and its VM-isolation nwfilter. */
export interface VmNetwork { name: string; bridge: string; gateway: string; filter: string }

/** Spec for defining a Jarvy KVM domain. */
export interface VmDomainSpec {
  name: string; memoryMiB: number; vcpus: number;
  osVolPath: string; workspaceVolPath?: string; seedVolPath: string;
  network: string; filter: string; mac: string;
}

/** Runs `virsh -c qemu:///system ...`; throws a concise error on non-zero exit. */
export function virsh(args: string[], timeoutMs = 60_000): Promise<string> {
  return execCmd("virsh", ["-c", VIRSH_URI, ...args], timeoutMs);
}

/** Runs an executable directly without a shell; returns trimmed stdout or rejects with the last diagnostic line. */
export function execCmd(program: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => execFile(program, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout.trim());
    const said = stderr.trim().split("\n").map(line => line.trim()).filter(Boolean).join("; ") || undefined;
    const ended = error.killed ? `${program} ${args[0] ?? ""} timed out after ${timeoutMs / 1000}s` : `${program} ${args[0] ?? ""} exited with ${error.code ?? error.signal}`;
    reject(Object.assign(new Error(said ?? (stdout.trim().split("\n").at(-1) || ended)), { code: (error as NodeJS.ErrnoException).code ?? "libvirt_failed" }));
  }));
}

/** Checks whether an executable exists on PATH (ENOENT means missing; non-zero exit from `--help` still means present). */
function hasBinary(program: string, flag = "--version"): Promise<boolean> {
  return new Promise(resolve => execFile(program, [flag], { timeout: 5_000 }, error => {
    resolve(!error || (error as NodeJS.ErrnoException).code !== "ENOENT");
  }));
}

/** Whether VirtualBox's driver is loaded; KVM fails while one of its VMs runs. */
function otherHypervisor(): boolean {
  try { return /^vboxdrv /m.test(readFileSync("/proc/modules", "utf8")); }
  catch { return false; }
}

/** Checks whether this machine can run libvirt + QEMU KVM sandboxes; null when ready. */
export async function libvirtProblem(): Promise<VmProblem | null> {
  if (!existsSync("/dev/kvm")) return { reason: "no_kvm", detail: "this machine has no /dev/kvm" };
  if (!await hasBinary("virsh") || !await hasBinary("qemu-system-x86_64"))
    return { reason: "no_libvirt", detail: "libvirt (virsh) or qemu-system-x86_64 is not installed" };
  if (!await hasBinary("qemu-img") || !await hasBinary("cloud-localds", "-h"))
    return { reason: "no_tools", detail: "qemu-img or cloud-localds is not installed" };
  try {
    await virsh(["version"], 10_000);
  } catch (error) {
    const said = (error as Error).message;
    if (/permission denied|authentication unavailable|access denied|polkit/i.test(said)) return { reason: "denied", detail: said };
    if (/failed to connect|cannot connect|no such file|connection refused/i.test(said)) return { reason: "stopped", detail: said };
    return { reason: "failed", detail: said };
  }
  try {
    await virsh(["domcapabilities", "--virttype", "kvm"], 15_000);
  } catch (error) {
    const said = (error as Error).message;
    if (otherHypervisor() || /resource busy|KVM_CREATE_VM/i.test(said)) return { reason: "busy", detail: said };
    if (/kvm|not supported|invalid argument/i.test(said)) return { reason: "no_kvm", detail: said };
    return { reason: "failed", detail: said };
  }
  return null;
}

/** This machine's CPUs and memory in bytes, read directly from the OS (independent of Docker). */
export function hostCapacity(): Capacity {
  return { cpus: Math.max(1, cpus().length), memory: totalmem() };
}

/** Ensures a directory storage pool under `/var/lib/libvirt/images/<name>` exists, is built, active and autostarted. */
export async function ensurePool(name: string): Promise<void> {
  let info = "";
  try { info = await virsh(["pool-info", name], 15_000); }
  catch (error) {
    if (!/storage pool not found|no storage pool/i.test((error as Error).message)) throw error;
    await virsh(["pool-define-as", name, "dir", "--target", `${POOL_ROOT}/${name}`], 30_000);
    await virsh(["pool-build", name], 30_000).catch(() => {});
    info = await virsh(["pool-info", name], 15_000);
  }
  if (!/^State:\s+running$/m.test(info)) await virsh(["pool-start", name], 30_000);
  if (!/^Autostart:\s+yes$/m.test(info)) await virsh(["pool-autostart", name], 15_000).catch(() => {});
}

export async function poolRefresh(pool: string): Promise<void> { await virsh(["pool-refresh", pool], 30_000); }

/** Matches only unambiguous `VIR_ERR_NO_STORAGE_VOL` responses, never the generic `failed to get vol` wrapper. */
const VOL_ABSENT = /storage volume not found|no storage vol/i;

/** Checks whether `vol` exists in `pool`. Returns false only on confirmed volume absence; rethrows RPC, permission,
 * pool or daemon errors so callers never mistake a lookup failure for an absent volume. */
export async function volExists(pool: string, vol: string): Promise<boolean> {
  try { await virsh(["vol-info", "--pool", pool, vol], 15_000); return true; }
  catch (error) {
    if (VOL_ABSENT.test((error as Error).message)) return false;
    throw error;
  }
}

export async function volPath(pool: string, vol: string): Promise<string> {
  return virsh(["vol-path", "--pool", pool, vol], 15_000);
}

/** Lists volume names in `pool`. */
export async function volList(pool: string): Promise<string[]> {
  const out = await virsh(["vol-list", pool], 15_000);
  return out.split("\n").slice(2).map(line => line.trim().split(/\s+/)[0] ?? "").filter(Boolean);
}

/** Actual host bytes allocated by `vol` (sparse qcow2 blocks on disk). */
export async function volAllocation(pool: string, vol: string): Promise<number | null> {
  try {
    const out = await virsh(["vol-info", "--pool", pool, vol, "--bytes"], 15_000);
    const bytes = /^Allocation:\s+(\d+)\s+bytes$/m.exec(out)?.[1];
    return bytes ? Number(bytes) : null;
  } catch { return null; }
}

/** The backing volume path of a qcow2 volume, or null when standalone. */
export async function volBackingPath(pool: string, vol: string): Promise<string | null> {
  try {
    const xml = await virsh(["vol-dumpxml", "--pool", pool, vol], 15_000);
    return /<backingStore>[\s\S]*?<path>([^<]+)<\/path>/.exec(xml)?.[1] ?? null;
  } catch { return null; }
}

/** Creates a thin-provisioned qcow2 volume, optionally backed by `backingVol` in the same pool. */
export async function volCreateQcow2(pool: string, vol: string, capacityBytes: number, backingVol?: string): Promise<string> {
  const args = ["vol-create-as", pool, vol, `${capacityBytes}`, "--format", "qcow2", "--allocation", "0"];
  if (backingVol) args.push("--backing-vol", backingVol, "--backing-vol-format", "qcow2");
  await virsh(args, 60_000);
  return volPath(pool, vol);
}

/** Uploads a local raw or qcow2 file into `pool` as `vol`, replacing any prior volume of the same name. */
export async function volUploadFile(pool: string, vol: string, localFile: string, format: "raw" | "qcow2"): Promise<string> {
  await volDelete(pool, vol);
  const bytes = format === "raw" ? (await stat(localFile)).size : await qcow2VirtualSize(localFile);
  await virsh(["vol-create-as", pool, vol, `${bytes}`, "--format", format, ...(format === "qcow2" ? ["--allocation", "0"] : [])], 60_000);
  await virsh(["vol-upload", "--pool", pool, vol, localFile], 600_000);
  await poolRefresh(pool);
  return volPath(pool, vol);
}

async function qcow2VirtualSize(file: string): Promise<number> {
  const info = JSON.parse(await execCmd("qemu-img", ["info", "--output=json", file], 30_000)) as { "virtual-size"?: number };
  if (!info["virtual-size"]) throw new Error(`qemu-img gave no virtual-size for ${file}`);
  return info["virtual-size"];
}

/** Clones a volume within the same pool via libvirtd (compacting/decoupling from temporary build volumes). */
export async function volClone(pool: string, src: string, dst: string): Promise<string> {
  await volDelete(pool, dst);
  await virsh(["vol-clone", "--pool", pool, src, dst], 600_000);
  return volPath(pool, dst);
}

export async function volDelete(pool: string, vol: string): Promise<void> {
  try { await virsh(["vol-delete", "--pool", pool, vol], 60_000); }
  catch (error) { if (!VOL_ABSENT.test((error as Error).message)) throw error; }
}

/** Ensures this Jarvy's isolated NAT network (`jarvy-<tag>`) and VM-isolation nwfilter exist and are active. */
export async function ensureVmNetwork(tag: string): Promise<VmNetwork> {
  const name = `jarvy-${tag}`, bridge = `jv${tag}`, filterName = `jarvy-${tag}-iso`;
  let gateway: string | null = null;
  try {
    const xml = await virsh(["net-dumpxml", name], 15_000);
    gateway = /<ip\s+address=['"]([^'"]+)['"]/.exec(xml)?.[1] ?? null;
  } catch (error) {
    if (!/network not found|no network/i.test((error as Error).message)) throw error;
  }
  if (!gateway) {
    const octet = await pickSubnetOctet(tag);
    gateway = `10.200.${octet}.1`;
    const xml = [
      "<network>",
      `  <name>${xmlEscape(name)}</name>`,
      "  <forward mode='nat'/>",
      `  <bridge name='${xmlEscape(bridge)}' stp='on' delay='0'/>`,
      `  <ip address='${gateway}' netmask='255.255.255.0'>`,
      `    <dhcp><range start='10.200.${octet}.10' end='10.200.${octet}.250'/></dhcp>`,
      "  </ip>",
      "</network>",
    ].join("\n");
    await withXmlFile(xml, file => virsh(["net-define", file], 30_000));
  }
  const info = await virsh(["net-info", name], 15_000);
  if (!/^Active:\s+yes$/m.test(info)) await virsh(["net-start", name], 30_000);
  if (!/^Autostart:\s+yes$/m.test(info)) await virsh(["net-autostart", name], 15_000).catch(() => {});
  const filter = await ensureIsolationFilter(filterName, gateway);
  return { name, bridge, gateway, filter };
}

/** Picks an unused `10.200.<octet>.0/24` subnet by checking existing libvirt networks and host routes. */
async function pickSubnetOctet(tag: string): Promise<number> {
  const used = new Set<number>();
  const names = (await virsh(["net-list", "--all", "--name"], 15_000).catch(() => "")).split("\n").map(line => line.trim()).filter(Boolean);
  for (const net of names) {
    const xml = await virsh(["net-dumpxml", net], 10_000).catch(() => "");
    const match = /<ip\s+address=['"]10\.200\.(\d+)\.\d+['"]/.exec(xml);
    if (match) used.add(Number(match[1]));
  }
  const routes = await readFile("/proc/net/route", "utf8").catch(() => "");
  for (const line of routes.split("\n").slice(1)) {
    const dest = line.trim().split(/\s+/)[1];
    if (dest && dest.length === 8) {
      const b0 = parseInt(dest.slice(6, 8), 16), b1 = parseInt(dest.slice(4, 6), 16), b2 = parseInt(dest.slice(2, 4), 16);
      if (b0 === 10 && b1 === 200) used.add(b2);
    }
  }
  const start = (parseInt(tag.slice(0, 2), 16) || 1) % 240 + 10;
  for (let offset = 0; offset < 240; offset++) {
    const octet = ((start - 10 + offset) % 240) + 10;
    if (!used.has(octet)) return octet;
  }
  throw new Error("No free 10.200.x.0/24 subnet available for Jarvy VM network");
}

/** Defines a libvirt nwfilter that allows VM↔gateway and VM↔internet while blocking VM↔VM traffic on the subnet.
 * Throws on failure so a VM is never defined or started without isolation. */
async function ensureIsolationFilter(name: string, gateway: string): Promise<string> {
  const subnet = gateway.replace(/\.\d+$/, ".0");
  const filters = await virsh(["nwfilter-list"], 15_000);
  const hasCleanTraffic = /\bclean-traffic\b/.test(filters);
  const xml = [
    `<filter name='${xmlEscape(name)}' chain='root'>`,
    ...(hasCleanTraffic ? ["  <filterref filter='clean-traffic'/>"] : []),
    "  <rule action='accept' direction='out' priority='400'>",
    `    <ip dstipaddr='${gateway}' dstipmask='32'/>`,
    "  </rule>",
    "  <rule action='drop' direction='out' priority='500'>",
    `    <ip dstipaddr='${subnet}' dstipmask='24'/>`,
    "  </rule>",
    "  <rule action='accept' direction='in' priority='400'>",
    `    <ip srcipaddr='${gateway}' srcipmask='32'/>`,
    "  </rule>",
    "  <rule action='drop' direction='in' priority='500'>",
    `    <ip srcipaddr='${subnet}' srcipmask='24'/>`,
    "  </rule>",
    "</filter>",
  ].join("\n");
  try {
    await withXmlFile(xml, file => virsh(["nwfilter-define", file], 30_000));
    return name;
  } catch (error) {
    throw new Error(`Failed to install VM isolation filter ${name}: ${(error as Error).message}`);
  }
}

/** Random locally-administered unicast MAC (`52:54:00:xx:yy:zz`) in libvirt's range. Assigned once per domain
 * definition so Stop→Start keeps the same MAC while Reset gets a fresh MAC with no stale DHCP lease collision. */
export function randomMac(): string {
  const bytes = randomBytes(3);
  return `52:54:00:${bytes[0]!.toString(16).padStart(2, "0")}:${bytes[1]!.toString(16).padStart(2, "0")}:${bytes[2]!.toString(16).padStart(2, "0")}`;
}

/** Reads the first NIC MAC address from an existing domain's XML, or null if missing. */
export async function domainMac(name: string): Promise<string | null> {
  const xml = await virsh(["dumpxml", name], 10_000).catch(() => "");
  return /<mac\s+address=['"]([^'"]+)['"]/.exec(xml)?.[1]?.toLowerCase() ?? null;
}

/** Builds KVM domain XML with `host-passthrough` CPU, ACPI, thin virtio disks (`discard=unmap`) and isolated NIC. */
export function domainXml(spec: VmDomainSpec): string {
  const disk = (path: string, dev: string) => [
    "    <disk type='file' device='disk'>",
    "      <driver name='qemu' type='qcow2' cache='none' discard='unmap'/>",
    `      <source file='${xmlEscape(path)}'/>`,
    `      <target dev='${dev}' bus='virtio'/>`,
    "    </disk>",
  ].join("\n");
  return [
    "<domain type='kvm'>",
    `  <name>${xmlEscape(spec.name)}</name>`,
    `  <memory unit='MiB'>${spec.memoryMiB}</memory>`,
    `  <currentMemory unit='MiB'>${spec.memoryMiB}</currentMemory>`,
    `  <vcpu placement='static'>${spec.vcpus}</vcpu>`,
    "  <os><type arch='x86_64' machine='pc'>hvm</type><boot dev='hd'/></os>",
    "  <features><acpi/><apic/></features>",
    "  <cpu mode='host-passthrough' check='none'/>",
    "  <clock offset='utc'/>",
    "  <on_poweroff>destroy</on_poweroff>",
    "  <on_reboot>restart</on_reboot>",
    "  <on_crash>destroy</on_crash>",
    "  <devices>",
    "    <emulator>/usr/bin/qemu-system-x86_64</emulator>",
    disk(spec.osVolPath, "vda"),
    ...(spec.workspaceVolPath ? [disk(spec.workspaceVolPath, "vdb")] : []),
    "    <disk type='file' device='cdrom'>",
    "      <driver name='qemu' type='raw'/>",
    `      <source file='${xmlEscape(spec.seedVolPath)}'/>`,
    "      <target dev='sda' bus='sata'/>",
    "      <readonly/>",
    "    </disk>",
    "    <interface type='network'>",
    `      <mac address='${spec.mac}'/>`,
    `      <source network='${xmlEscape(spec.network)}'/>`,
    "      <model type='virtio'/>",
    `      <filterref filter='${xmlEscape(spec.filter)}'/>`,
    "    </interface>",
    "    <serial type='pty'/>",
    "    <console type='pty'/>",
    "    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>",
    "  </devices>",
    "</domain>",
  ].join("\n");
}

export async function defineDomain(xml: string): Promise<void> {
  await withXmlFile(xml, file => virsh(["define", file], 30_000));
}

export async function startDomain(name: string): Promise<void> {
  await virsh(["start", name], 60_000);
}

/** Sends ACPI shutdown and waits up to `graceMs` before forcing `destroy`. */
export async function shutdownDomain(name: string, graceMs = 20_000): Promise<void> {
  if (await domainState(name) !== "running") return;
  await virsh(["shutdown", name], 15_000).catch(() => {});
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await domainState(name) !== "running") return;
  }
  await destroyDomain(name);
}

export async function destroyDomain(name: string): Promise<void> {
  try { await virsh(["destroy", name], 30_000); }
  catch (error) { if (!/not running|not found|no domain|failed to get domain/i.test((error as Error).message)) throw error; }
}

export async function undefineDomain(name: string): Promise<void> {
  await destroyDomain(name);
  try { await virsh(["undefine", name, "--nvram"], 30_000); }
  catch {
    try { await virsh(["undefine", name], 30_000); }
    catch (error) { if (!/not found|no domain|failed to get domain/i.test((error as Error).message)) throw error; }
  }
}

export async function domainState(name: string): Promise<ContainerState> {
  try {
    const state = (await virsh(["domstate", name], 10_000)).toLowerCase();
    return state === "running" || state === "idle" || state === "paused" ? "running" : "stopped";
  } catch (error) {
    if (/not found|no domain|failed to get domain/i.test((error as Error).message)) return "missing";
    throw error;
  }
}

/** States of all defined domains whose name starts with `prefix`. */
export async function domainStates(prefix: string): Promise<Map<string, ContainerState>> {
  const out = await virsh(["list", "--all"], 15_000);
  const states = new Map<string, ContainerState>();
  for (const line of out.split("\n").slice(2)) {
    const match = /^\s*\S+\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || !match[1]!.startsWith(prefix)) continue;
    states.set(match[1]!, match[2]!.toLowerCase() === "running" ? "running" : "stopped");
  }
  return states;
}

/** Updates a domain's persistent memory and vCPU counts (takes effect at its next boot). */
export async function updateDomainSize(name: string, memoryMiB: number, vcpus: number): Promise<void> {
  const xml = await virsh(["dumpxml", "--inactive", name], 15_000);
  const kib = memoryMiB * 1024;
  const updated = xml
    .replace(/<memory\b[^>]*>\d+<\/memory>/, `<memory unit='KiB'>${kib}</memory>`)
    .replace(/<currentMemory\b[^>]*>\d+<\/currentMemory>/, `<currentMemory unit='KiB'>${kib}</currentMemory>`)
    .replace(/<vcpu\b[^>]*>\d+<\/vcpu>/, `<vcpu placement='static'>${vcpus}</vcpu>`);
  await defineDomain(updated);
}

/** Finds a running domain's IPv4 address from live ARP or libvirt DHCP leases (newest lease wins); null until obtained. */
export async function domainIp(name: string, network: string, mac?: string): Promise<string | null> {
  for (const source of ["arp", "lease"] as const) {
    const out = await virsh(["domifaddr", name, "--source", source], 10_000).catch(() => "");
    const matches = [...out.matchAll(/\bipv4\s+(\d+\.\d+\.\d+\.\d+)\/\d+/g)];
    const ip = matches.at(-1)?.[1];
    if (ip) return ip;
  }
  const targetMac = (mac ?? await domainMac(name))?.toLowerCase();
  if (targetMac) {
    const leases = await virsh(["net-dhcp-leases", network], 10_000).catch(() => "");
    const rows = leases.split("\n").filter(row => row.toLowerCase().includes(targetMac));
    const ip = /\bipv4\s+(\d+\.\d+\.\d+\.\d+)\/\d+/.exec(rows.at(-1) ?? "")?.[1];
    if (ip) return ip;
  }
  return null;
}

/** Maps active DHCP lease MACs to IPv4 addresses on `network`. */
export async function networkLeases(network: string): Promise<Map<string, string>> {
  const out = await virsh(["net-dhcp-leases", network], 10_000).catch(() => "");
  const byMac = new Map<string, string>();
  for (const line of out.split("\n").slice(2)) {
    const match = /\b((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+ipv4\s+(\d+\.\d+\.\d+\.\d+)\/\d+/i.exec(line);
    if (match) byMac.set(match[1]!.toLowerCase(), match[2]!);
  }
  return byMac;
}

/** Resident memory of the host QEMU process running `name`, in bytes, or null if unreadable. */
export async function qemuMemory(name: string): Promise<number | null> {
  const needle = `guest=${name},`;
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    if (!cmdline.includes(needle) || !cmdline.includes("qemu-system")) continue;
    const status = await readFile(`/proc/${entry}/status`, "utf8").catch(() => "");
    const kib = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    return kib ? Number(kib) * 1024 : null;
  }
  return null;
}

async function withXmlFile<T>(xml: string, work: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jarvy-libvirt-"));
  const file = join(dir, "def.xml");
  try {
    await writeFile(file, xml, { mode: 0o600 });
    return await work(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function xmlEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}
