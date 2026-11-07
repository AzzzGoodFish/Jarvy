import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { mkdir, open, rm } from "node:fs/promises";
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
