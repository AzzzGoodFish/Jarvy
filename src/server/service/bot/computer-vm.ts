import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../../infra/storage/store.js";
import type { EnvironmentRecord, WorkEnvironment } from "../../shared/environment.js";
import type { ComputerLimits, ComputerType, ComputerUsage, VmProblemReason, VmSupport } from "../../../contract/environment.js";
import { buildImage, computerImage, computerRecipe, imageExists, pruneImages, type ContainerState } from "../../infra/env/docker.js";
import {
  defineDomain, domainIp, domainMac, domainState, domainStates, domainXml, ensurePool, ensureVmNetwork,
  libvirtProblem, networkLeases, qemuMemory, randomMac, shutdownDomain, startDomain, undefineDomain, updateDomainSize,
  volAllocation, volCreateQcow2, volDelete, volExists, volPath, volUploadFile, type VmNetwork,
} from "../../infra/env/libvirt.js";
import { clearRuntime, generateKey, publicKeyOf, type SshAccess } from "../../infra/env/ssh.js";
import { buildVmTemplate, vmTemplateTag } from "../../infra/env/vm-template.js";
import {
  VM_OS_DISK_BYTES, VM_WORKSPACE_DISK_BYTES, ensureVmHostEntry, exportWorkspace, importWorkspace, makeBotSeedIso,
  trimVmDisks, vmEnvironment, vmListeningPorts, vmSshAccess, vmUsage, waitForVmReady,
} from "../../infra/env/vm-guest.js";

/** A VM sandbox's size when the owner set none (A85, A99): 4 GB of memory and 2 vCPUs. */
export const VM_SIZE = { memory: 4 * 2 ** 30, cpus: 2 } as const;
/** What a Bot's sandbox is (A85, A99), as kept with it; a container unless made a VM. */
export const computerType = (record: EnvironmentRecord): ComputerType => record.spec.type === "vm" ? "vm" : "container";

/** Container sandbox image builder (A50). Built on first use and shared across all container sandboxes. */
export class ComputerImages {
  private base: Promise<string> | null = null;
  constructor(private readonly dataDir: string, private readonly uid: number, private readonly gid: number, private readonly log: (text: string) => void) {}
  tag(type: ComputerType): string { return type === "vm" ? vmTemplateTag() : computerImage(this.uid, this.gid); }
  ready(): Promise<string> {
    this.base ??= this.build(computerImage(this.uid, this.gid), computerRecipe(this.uid, this.gid)).catch(error => { this.base = null; throw error; });
    return this.base;
  }
  private async build(tag: string, recipe: Parameters<typeof buildImage>[1]): Promise<string> {
    if (await imageExists(tag)) return tag;
    this.log(`building ${tag}`);
    await buildImage(tag, recipe, join(this.dataDir, "computers", "build.log"));
    void pruneImages([tag]).then(removed => { if (removed.length) this.log(`removed ${removed.join(", ")}`); }).catch(() => {});
    return tag;
  }
}

/** Whether this machine can run libvirt + QEMU VM sandboxes (A99); checked on demand and cached. */
export class VmSupportCheck {
  private known: VmSupport = { state: "unknown" };
  private running: Promise<VmSupport> | null = null;
  constructor(private readonly log: (text: string) => void) {}
  get current(): VmSupport { return this.known; }
  get available(): boolean { return this.known.state === "available"; }
  get reason(): VmProblemReason | undefined { return this.known.state === "unavailable" ? this.known.reason : undefined; }
  check(again = false): Promise<VmSupport> {
    if (this.running) return this.running;
    if (!again && this.known.state !== "unknown") return Promise.resolve(this.known);
    this.known = { state: "checking" };
    this.running = (async (): Promise<VmSupport> => {
      try {
        const problem = await libvirtProblem();
        if (problem) this.log(`VM sandboxes can't be used (${problem.reason}): ${problem.detail}`);
        return problem ? { state: "unavailable", ...problem } : { state: "available" };
      } catch (error) { return { state: "unavailable", reason: "failed", detail: (error as Error).message }; }
    })().then(answer => { this.known = answer; return answer; }).finally(() => { this.running = null; });
    return this.running;
  }
}

interface VmVolumes { os: string; workspace: string; seed: string }
const vmVolumes = (name: string): VmVolumes => ({ os: `${name}-os.qcow2`, workspace: `${name}-workspace.qcow2`, seed: `${name}-seed.iso` });

/** Manages libvirt + QEMU system VM sandboxes for a Jarvy installation (A99): shared backing template, per-Bot
 * thin OS and `/workspace` qcow2 disks, bidirectional lossless workspace sync, isolated NAT network, SSH `pi-env`
 * connections, live usage and published-port resolution. */
export class VmSandboxes {
  readonly pool: string;
  private readonly runtimeDir: string;
  private infra: Promise<VmNetwork> | null = null;
  private template: Promise<string> | null = null;
  private network: VmNetwork | null = null;
  private readonly ips = new Map<string, string>();
  private leases: { at: number; byMac: Map<string, string> } | null = null;

  constructor(private readonly deps: { store: Store; dataDir: string; tag: string; hostName: string; log: (text: string) => void }) {
    this.pool = `jarvy-${deps.tag}`;
    this.runtimeDir = join(deps.dataDir, "computers", "vm-ssh");
    clearRuntime(this.runtimeDir);
  }

  private ensureInfra(): Promise<VmNetwork> {
    this.infra ??= (async () => {
      await ensurePool(this.pool);
      const net = await ensureVmNetwork(this.deps.tag);
      this.network = net;
      return net;
    })().catch(error => { this.infra = null; throw error; });
    return this.infra;
  }

  private readyTemplate(network: VmNetwork): Promise<string> {
    this.template ??= buildVmTemplate(this.pool, network, this.runtimeDir, join(this.deps.dataDir, "computers", "vm-build.log"), this.deps.log)
      .catch(error => { this.template = null; throw error; });
    return this.template;
  }

  /** Ensures the Bot's VM domain, disks, seed ISO and guest cloud-init are running and SSH-ready; imports host
   * `workspace/` files on first creation of `workspace.qcow2`. */
  async ensure(record: EnvironmentRecord, limits: ComputerLimits, hostWorkspace: string): Promise<SshAccess> {
    const network = await this.ensureInfra();
    const baseVol = await this.readyTemplate(network);
    const name = record.spec.container!;
    const vols = vmVolumes(name);
    const memoryMiB = Math.max(1024, Math.round((limits.memory ?? VM_SIZE.memory) / 2 ** 20));
    const vcpus = Math.max(1, Math.round(limits.cpus ?? VM_SIZE.cpus));

    const wsExists = await volExists(this.pool, vols.workspace);
    const workspaceVolPath = wsExists ? await volPath(this.pool, vols.workspace) : await volCreateQcow2(this.pool, vols.workspace, VM_WORKSPACE_DISK_BYTES);
    const osExists = await volExists(this.pool, vols.os);
    const osVolPath = osExists ? await volPath(this.pool, vols.os) : await volCreateQcow2(this.pool, vols.os, VM_OS_DISK_BYTES, baseVol);

    let auth = this.deps.store.environments.computerAuth(record.id);
    const needSeed = !auth || !osExists || !await volExists(this.pool, vols.seed);
    let seedVolPath: string;
    if (needSeed) {
      const client = auth ? { privateKey: auth.privateKey, publicKey: publicKeyOf(auth.privateKey, name) } : null;
      const clientKey = client?.publicKey ? { privateKey: client.privateKey, publicKey: client.publicKey } : await generateKey(this.runtimeDir, name);
      const hostKey = await generateKey(this.runtimeDir, `${name}-host`);
      const bareHost = hostKey.publicKey.split(" ").slice(0, 2).join(" ");
      this.deps.store.environments.setComputerAuth(record.id, { privateKey: clientKey.privateKey, hostKey: bareHost });
      auth = { privateKey: clientKey.privateKey, hostKey: bareHost };
      seedVolPath = await this.uploadBotSeed(vols.seed, {
        instanceId: `${name}-${Date.now().toString(36)}`, hostname: name,
        hostPrivateKey: hostKey.privateKey, hostPublicKey: hostKey.publicKey,
        clientPublicKey: clientKey.publicKey, hostGatewayIp: network.gateway, hostName: this.deps.hostName,
      });
    } else {
      seedVolPath = await volPath(this.pool, vols.seed);
    }

    const state = await domainState(name);
    let mac: string | undefined;
    if (state === "missing") {
      mac = randomMac();
      await defineDomain(domainXml({ name, memoryMiB, vcpus, osVolPath, workspaceVolPath, seedVolPath, network: network.name, filter: network.filter, mac }));
      await startDomain(name);
    } else {
      mac = (await domainMac(name)) ?? undefined;
      if (state === "stopped") await startDomain(name);
    }

    const ip = await this.waitIp(name, network.name, mac, 120_000);
    this.ips.set(name, ip);
    this.leases = null;
    const access = vmSshAccess(this.runtimeDir, name, ip, auth!.hostKey, auth!.privateKey);
    await waitForVmReady(access, 180_000);
    await ensureVmHostEntry(access, this.deps.hostName, network.gateway).catch(() => {});
    if (!wsExists) await importWorkspace(access, hostWorkspace);
    void trimVmDisks(access).catch(() => {});
    return access;
  }

  private async uploadBotSeed(seedVol: string, spec: Parameters<typeof makeBotSeedIso>[1]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "jarvy-vm-seed-"));
    try {
      const iso = join(dir, "seed.iso");
      await makeBotSeedIso(iso, spec);
      return await volUploadFile(this.pool, seedVol, iso, "raw");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  /** Opens a `pi-env` over SSH `WorkEnvironment` to a running VM. */
  environment(record: EnvironmentRecord, access: SshAccess, onLog: (text: string) => void): WorkEnvironment {
    return vmEnvironment(record.id, access, onLog);
  }

  async stop(name: string): Promise<void> {
    await shutdownDomain(name);
    this.ips.delete(name);
  }

  /** Resets the VM: shuts down cleanly so `/workspace` flushes to disk, wipes OS disk and seed ISO, and preserves
   * `workspace.qcow2` (A99). */
  async reset(record: EnvironmentRecord): Promise<void> {
    const name = record.spec.container!, vols = vmVolumes(name);
    await shutdownDomain(name);
    await undefineDomain(name);
    await volDelete(this.pool, vols.os);
    await volDelete(this.pool, vols.seed);
    this.deps.store.environments.clearComputerAuth(record.id);
    this.ips.delete(name);
  }

  /** Removes a VM sandbox; when `keepFiles` is true and `workspace.qcow2` exists, exports `/workspace` back to
   * `hostWorkspace` losslessly before deleting any disk volume. */
  async remove(record: EnvironmentRecord, limits: ComputerLimits, hostWorkspace: string, keepFiles: boolean): Promise<void> {
    const name = record.spec.container!, vols = vmVolumes(name);
    const poolReady = await this.ensureInfra().then(() => true, () => false);
    if (poolReady && keepFiles && await volExists(this.pool, vols.workspace)) {
      const access = await this.ensure(record, limits, hostWorkspace);
      await exportWorkspace(access, hostWorkspace);
    }
    await undefineDomain(name).catch(() => {});
    if (poolReady) {
      await volDelete(this.pool, vols.os).catch(() => {});
      await volDelete(this.pool, vols.workspace).catch(() => {});
      await volDelete(this.pool, vols.seed).catch(() => {});
    }
    this.deps.store.environments.clearComputerAuth(record.id);
    this.ips.delete(name);
  }

  async updateLimits(name: string, limits: ComputerLimits): Promise<void> {
    if (await domainState(name) === "missing") return;
    const memoryMiB = Math.max(1024, Math.round((limits.memory ?? VM_SIZE.memory) / 2 ** 20));
    const vcpus = Math.max(1, Math.round(limits.cpus ?? VM_SIZE.cpus));
    await updateDomainSize(name, memoryMiB, vcpus);
  }

  async state(name: string): Promise<ContainerState> { return domainState(name); }

  async address(record: EnvironmentRecord): Promise<string | null> {
    const name = record.spec.container!;
    const cached = this.ips.get(name);
    if (cached && await domainState(name) === "running") return cached;
    if (!this.network) return null;
    const ip = await domainIp(name, this.network.name);
    if (ip) this.ips.set(name, ip);
    return ip;
  }

  /** Reverse-looks up which Bot's VM owns `address` on this Jarvy's VM network. */
  async botAt(address: string, vmRecords: readonly EnvironmentRecord[]): Promise<string | null> {
    if (!vmRecords.length) return null;
    for (const record of vmRecords) if (this.ips.get(record.spec.container!) === address) return record.botId ?? null;
    if (!this.network) return null;
    const byMac = await this.leaseMap(false);
    const macs = await Promise.all(vmRecords.map(async record => [record.botId ?? null, await domainMac(record.spec.container!)] as const));
    const match = (map: Map<string, string>) => macs.find(([, mac]) => mac && map.get(mac) === address)?.[0] ?? null;
    return match(byMac) ?? match(await this.leaseMap(true));
  }

  private async accessOf(record: EnvironmentRecord): Promise<SshAccess | null> {
    const auth = this.deps.store.environments.computerAuth(record.id);
    const ip = auth ? await this.address(record) : null;
    return auth && ip ? vmSshAccess(this.runtimeDir, record.spec.container!, ip, auth.hostKey, auth.privateKey) : null;
  }

  async listening(record: EnvironmentRecord): Promise<Map<number, { loopbackOnly: boolean }> | null> {
    const access = await this.accessOf(record);
    return access ? vmListeningPorts(access) : null;
  }

  async resources(record: EnvironmentRecord): Promise<ComputerUsage | null> {
    const access = await this.accessOf(record);
    if (!access) return null;
    const name = record.spec.container!, vols = vmVolumes(name);
    const [inside, hostMem, osAlloc, wsAlloc] = await Promise.all([
      vmUsage(access), qemuMemory(name).catch(() => null),
      volAllocation(this.pool, vols.os), volAllocation(this.pool, vols.workspace),
    ]);
    const hostDisk = osAlloc === null && wsAlloc === null ? null : (osAlloc ?? 0) + (wsAlloc ?? 0);
    return { ...inside, host: { memory: hostMem, disk: hostDisk } };
  }

  /** Syncs domain states for this Jarvy prefix and removes orphaned domains whose Bot is gone. */
  async sweep(ownedNames: ReadonlySet<string>): Promise<Map<string, ContainerState>> {
    const prefix = `jarvy-${this.deps.tag}-`;
    const states = await domainStates(prefix);
    for (const name of states.keys()) {
      if (ownedNames.has(name) || name.startsWith(`${prefix}build-`)) continue;
      this.deps.log(`removing orphaned VM ${name}`);
      const vols = vmVolumes(name);
      await undefineDomain(name).catch(() => {});
      await volDelete(this.pool, vols.os).catch(() => {});
      await volDelete(this.pool, vols.workspace).catch(() => {});
      await volDelete(this.pool, vols.seed).catch(() => {});
    }
    if (ownedNames.size && !this.network) void this.ensureInfra().catch(() => {});
    return states;
  }

  close(): void { clearRuntime(this.runtimeDir); }

  private async leaseMap(fresh: boolean): Promise<Map<string, string>> {
    const age = this.leases ? Date.now() - this.leases.at : Infinity;
    if (this.leases && (fresh ? age < 1000 : age < 5000)) return this.leases.byMac;
    const byMac = this.network ? await networkLeases(this.network.name) : new Map<string, string>();
    this.leases = { at: Date.now(), byMac };
    return byMac;
  }

  private async waitIp(name: string, network: string, mac: string | undefined, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ip = await domainIp(name, network, mac);
      if (ip) return ip;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error(`VM ${name} did not obtain an IP address within ${timeoutMs / 1000}s`);
  }
}
