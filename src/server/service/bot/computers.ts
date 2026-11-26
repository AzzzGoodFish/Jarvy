import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import type { Duplex } from "node:stream";
import type { Store } from "../../infra/storage/store.js";
import {
  COMPUTER_CWD, addHost, containerEnvironment, containerNetworks, containerState, containerStates, containerUsage,
  dockerCapacity, dockerProblem, ensureNetwork, homeAtWorkspace, listeningPorts, moveToNetwork, networkAddresses,
  removeContainer, runContainer, startContainer, stopContainer, syncDaemon, updateLimits, type Capacity, type DockerProblem,
} from "../../infra/env/docker.js";
import { openContainerFs } from "../../infra/env/env-fs.js";
import { openWorkspaceFs } from "../../infra/env/workspace-fs.js";
import { hostCapacity } from "../../infra/env/libvirt.js";
import { openSshFs, openSshPty } from "../../infra/env/ssh.js";
import { openContainerPty } from "../../infra/env/terminal.js";
import { ComputerImages, MIN_LIMITS, VmSandboxes, VmSupportCheck, computerLimits, computerType, dockerProblemMessage, parseComputerLimit, vmProblemMessage } from "./computer-vm.js";
import { createSandboxEnvironment, dockerUnavailableFault, runWithSandboxRecovery } from "./computer-workspace.js";
import type { ComputePool } from "./compute-pool.js";
import type { EnvironmentRecord, WorkEnvironment } from "../../shared/environment.js";
import type { EnvironmentFs } from "../../shared/env-files.js";
import type { PtyHandle, PtyOpenOptions } from "../../shared/terminal.js";
import type { ComputerInfo, ComputerResources, ComputerStatus, ComputerType, VmSupport } from "../../../contract/environment.js";
import { ChatError } from "../../shared/chat.js";
import { RuntimeFault } from "../../shared/runtime.js";
import { ValidationError } from "../../shared/errors.js";

export { computerLimits };

const SWEEP_MS = 60_000;
/** How often Jarvy looks for Docker again while it can't be used, so fixing it needs no restart. */
const RECHECK_MS = 30_000;
/** The name sandboxes reach this machine by (A74), as Docker Desktop calls it. */
export const HOST_NAME = "host.docker.internal";

export interface ComputerDependencies {
  store: Store;
  compute?: ComputePool;
  changed: () => void;
  onEnvironmentClosed?: (environmentId: string) => void;
  log?: (text: string) => void;
}

/** Bots' sandboxes (A50, A101): Docker containers (default) or full Linux virtual machines (libvirt + QEMU), each with
 * its own `/workspace`. Containers and VMs have independent host checks (Docker vs libvirt/KVM), so VMs still run even
 * without Docker on the host. Sandboxes keep running when Jarvy stops so background work survives restarts. */
export class Computers {
  private docker: boolean | null = null;
  private problem: DockerProblem | null = null;
  private recheck: NodeJS.Timeout | null = null;
  private closed = false;
  private probing: Promise<void> | null = null;
  private readonly images: ComputerImages;
  private readonly vms: VmSupportCheck;
  private readonly libvirt: VmSandboxes;
  /** VM sandboxes resized while running: the new size takes effect on next start. */
  private readonly resized = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly states = new Map<string, ComputerStatus>();
  private readonly preparing = new Map<string, Promise<string>>();
  private readonly connections = new Map<string, WorkEnvironment>();
  /** In-flight connect calls per Bot, and a generation bumped on disconnect so stale opens never leak an SSH child. */
  private readonly connecting = new Map<string, Promise<WorkEnvironment>>();
  private readonly epoch = new Map<string, number>();
  /** Container sandboxes set up since they last started: home checked and host name added. */
  private readonly homes = new Map<string, Promise<void>>();
  private network: { name: string; gateway: string } | null = null;
  private book: { at: number; byName: Map<string, string> } | null = null;
  private machine: Promise<Capacity> | null = null;
  private readonly dataDir: string;
  private readonly tag: string;
  private readonly uid = process.getuid?.() ?? 1000;
  private readonly gid = process.getgid?.() ?? 1000;

  constructor(private readonly deps: ComputerDependencies) {
    this.dataDir = dirname(deps.store.path);
    this.tag = createHash("sha256").update(this.dataDir).digest("hex").slice(0, 12);
    const log = (text: string) => this.log(text);
    this.images = new ComputerImages(this.dataDir, this.uid, this.gid, log);
    this.vms = new VmSupportCheck(log);
    this.libvirt = new VmSandboxes({ store: deps.store, dataDir: this.dataDir, tag: this.tag.slice(0, 6), hostName: HOST_NAME, log });
  }

  /** Probes Docker and libvirt and learns every sandbox's state. */
  start(): Promise<void> {
    this.probing ??= this.probe();
    return this.probing;
  }
  private async probe(): Promise<void> {
    await this.vms.check();
    const problem = await dockerProblem();
    if (problem) {
      this.unusable(problem);
    } else {
      try {
        await syncDaemon(join(this.dataDir, "computers", "bin"));
        const found = this.docker === false;
        this.docker = true; this.problem = null;
        if (found) this.log("Docker can be used now");
        await this.joinNetwork().catch(error => this.log(`sandbox network unavailable, staying on the default bridge: ${(error as Error).message}`));
        if (found) this.deps.changed();
      } catch (error) {
        this.unusable({ reason: "failed", detail: `the tools' daemon could not be put in place: ${(error as Error).message}` });
      }
    }
    await this.sweep().catch(error => this.log(`computer sweep failed: ${(error as Error).message}`));
    if (!this.timer) {
      this.timer = setInterval(() => void this.sweep().catch(error => this.log(`computer sweep failed: ${(error as Error).message}`)), SWEEP_MS);
      this.timer.unref();
    }
  }
  private unusable(problem: DockerProblem): void {
    const before = this.docker === null ? null : this.problem?.reason;
    if (before !== problem.reason) this.log(`Docker can't be used (${problem.reason}): ${problem.detail}`);
    this.docker = false; this.problem = problem;
    if (before && before !== problem.reason) this.deps.changed();
    if (this.closed || this.recheck) return;
    this.recheck = setTimeout(() => { this.recheck = null; void this.probe(); }, RECHECK_MS);
    this.recheck.unref();
  }
  /** Why Docker can't be used, in a Bot's words; null when it can, or before Jarvy has looked. */
  get dockerProblem(): string | null {
    const problem = this.docker === false ? this.problem : null;
    return problem ? dockerProblemMessage(problem.reason, problem.detail, userInfo().username) : null;
  }
  sandboxProblem(botId: string): string | null {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return null;
    if (computerType(computer) !== "vm") return this.dockerProblem && !this.hasRemoteCompute("container") ? this.dockerProblem : null;
    if (this.vms.current.state !== "unavailable" || this.hasRemoteCompute("vm")) return null;
    return vmProblemMessage(this.vms.reason, userInfo().username, this.vms.current.detail);
  }
  private hasRemoteCompute(type: ComputerType = "container"): boolean { return Boolean(this.deps.compute?.hasOnlineNode(type)); }
  private useRemote(type: ComputerType): boolean { return type === "vm" ? !this.vms.available && this.hasRemoteCompute("vm") : this.docker !== true && this.hasRemoteCompute("container"); }
  get available(): boolean { return this.docker === true || this.hasRemoteCompute("container"); }
  canRun(record: EnvironmentRecord): boolean { return computerType(record) === "vm" ? this.vms.available || this.hasRemoteCompute("vm") : this.available; }

  status(botId: string): ComputerStatus | null {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return null;
    const type = computerType(computer);
    if (this.useRemote(type)) {
      if (this.preparing.has(botId)) return { state: "preparing" };
      const remote = this.deps.compute!.placement(botId);
      return remote?.type === type && remote.state === "running" ? { state: "running" } : { state: "stopped" };
    }
    if (type === "vm") return this.vms.current.state === "unavailable" ? { state: "unavailable", error: this.vms.reason ?? "failed" } : (this.states.get(botId) ?? { state: "stopped" });
    if (this.docker !== true) return { state: "unavailable", ...(this.problem ? { error: this.problem.reason } : {}) };
    return this.states.get(botId) ?? { state: "stopped" };
  }
  info(botId: string): ComputerInfo | null {
    const computer = this.deps.store.environments.computerOf(botId), status = this.status(botId);
    if (!computer || !status) return null;
    const type = computerType(computer), remote = (type === "vm" ? !this.vms.available : this.docker !== true) ? this.deps.compute?.placement(botId) : null;
    return { id: computer.id, ...status, type, container: remote?.container ?? computer.spec.container!, image: remote?.image ?? this.images.tag(type), workspace: this.workspace(botId), mount: COMPUTER_CWD,
      limits: computerLimits(computer), ...(this.resized.has(botId) ? { restartNeeded: true } : {}),
      ...(remote ? { computeNode: { id: remote.deviceId, name: remote.deviceName } } : {}),
      preferredComputeNode: computer.spec.computeNode ?? null, localDocker: this.docker === true, localVm: this.vms.available, remoteVmAvailable: this.hasRemoteCompute("vm") };
  }
  get vmSupport(): VmSupport { return this.vms.current; }
  checkVms(again = false): Promise<VmSupport> { return this.vms.check(again); }

  /** Switches a Bot's sandbox between container and system VM (A101, A110), preserving `/workspace`. */
  async setType(botId: string, type: ComputerType): Promise<void> {
    const computer = this.record(botId), current = computerType(computer);
    if (current === type) return;
    if (type === "vm") {
      const support = await this.vms.check();
      if (support.state !== "available" && !this.hasRemoteCompute("vm")) throw new ValidationError("This machine can't run VM sandboxes", "vm_unavailable", { reason: support.reason ?? "failed" });
    } else if (!this.available) throw this.unavailable(409);
    await this.settled(botId); this.deps.onEnvironmentClosed?.(computer.id); await this.disconnect(botId);
    if (!(await this.deps.compute?.remove(botId, true))) {
      if (current === "vm") await this.libvirt.remove(computer, computerLimits(computer), this.workspace(botId), true);
      else if (this.docker === true) await removeContainer(computer.spec.container!);
    }
    this.homes.delete(computer.spec.container!); this.resized.delete(botId);
    this.deps.store.environments.setType(computer.id, type);
    this.set(botId, { state: "stopped" }); this.deps.changed();
  }

  async resources(botId: string): Promise<ComputerResources> {
    const computer = this.record(botId), name = computer.spec.container!, type = computerType(computer), remote = this.useRemote(type) ? this.deps.compute : undefined;
    const usage = this.status(botId)?.state !== "running" ? null : remote ? await remote.usage(botId).catch(() => null)
      : type === "vm" ? await this.libvirt.resources(computer).catch(() => null) : await containerUsage(name).catch(() => null);
    return { usage, capacity: remote ? remote.capacity(botId, computer.spec.computeNode, type) : await this.capacity(type).catch(() => null) };
  }
  async setComputeNode(botId: string, deviceId: string | null): Promise<void> {
    const computer = this.record(botId);
    if (deviceId !== null && this.deps.store.environments.get(deviceId)?.kind !== "device") throw new ChatError(404, "No computer with this id", "device_missing");
    this.deps.store.environments.setComputeNode(computer.id, deviceId);
    this.deps.compute?.clearStoppedPlacement(botId); this.deps.changed();
  }
  async reclaim(botId: string): Promise<void> {
    const computer = this.record(botId);
    await this.settled(botId); this.deps.onEnvironmentClosed?.(computer.id); await this.disconnect(botId);
    await this.deps.compute?.reclaim(botId);
  }
  async setLimits(botId: string, input: { memory: unknown; cpus: unknown }): Promise<void> {
    const computer = this.record(botId), type = computerType(computer), remote = this.useRemote(type) ? this.deps.compute : undefined;
    const machine = remote ? (remote.capacity(botId, computer.spec.computeNode, type) ?? (() => { throw this.unavailable(409); })()) : await this.capacity(type);
    const least = MIN_LIMITS[type], memory = parseComputerLimit(input.memory, least.memory, machine.memory, 2 ** 20), cpus = parseComputerLimit(input.cpus, least.cpus, machine.cpus, type === "vm" ? 1 : 0.01);
    if (memory === undefined || cpus === undefined) throw new ValidationError("Limits are null or a number within this machine's size", type === "vm" ? "vm_size_invalid" : "limits_invalid",
      { memory: Math.floor(machine.memory / 2 ** 30 * 10) / 10, cpus: machine.cpus });
    const next = computerLimits({ ...computer, spec: { ...computer.spec, memory: memory === null ? "" : String(memory), cpus: cpus === null ? "" : String(cpus) } });
    const before = computerLimits(computer), change = { ...(next.memory !== before.memory ? { memory: next.memory } : {}), ...(next.cpus !== before.cpus ? { cpus: next.cpus } : {}) };
    if (Object.keys(change).length) {
      if (remote) { await remote.updateLimits(botId, next); if (this.status(botId)?.state === "running") this.resized.add(botId); }
      else if (type === "vm") { const state = await this.libvirt.state(computer.spec.container!); if (state !== "missing") await this.libvirt.updateLimits(computer.spec.container!, next); if (state === "running") this.resized.add(botId); }
      else { if (!this.available) throw this.unavailable(409); if (await containerState(computer.spec.container!) !== "missing") await updateLimits(computer.spec.container!, change, machine); }
    }
    this.deps.store.environments.setLimits(computer.id, { memory, cpus }); this.deps.changed();
  }
  private capacity(type: ComputerType): Promise<Capacity> {
    if (type === "vm") return Promise.resolve(hostCapacity());
    this.machine ??= dockerCapacity().catch(error => { this.machine = null; throw error; });
    return this.machine;
  }

  adopt(botIds: readonly string[]): void {
    for (const botId of botIds) if (!this.deps.store.environments.computerOf(botId)) this.create(botId);
  }
  create(botId: string): void {
    const computer = this.deps.store.environments.addComputer(botId, `jarvy-${this.tag.slice(0, 6)}-${botId.slice(0, 8)}`);
    this.deps.store.environments.setHome(botId, computer.id);
    if (this.available) void this.ensure(botId).catch(() => {});
  }

  environment(botId: string, record: EnvironmentRecord): WorkEnvironment {
    const run = async <T>(op: (env: WorkEnvironment) => Promise<T>): Promise<T> => {
      const current = this.deps.store.environments.computerOf(botId) ?? record, type = computerType(current);
      if (this.useRemote(type)) return op(this.deps.compute!.environment(botId, current));
      return runWithSandboxRecovery(op, {
        connect: () => this.connect(botId, current),
        isRunning: async () => (type === "vm"
          ? await this.libvirt.state(current.spec.container!).catch(() => "missing")
          : await containerState(current.spec.container!).catch(() => "missing")) === "running",
        resetStopped: async () => { await this.disconnect(botId); this.set(botId, { state: "stopped" }); },
      });
    };
    const isContainer = () => computerType(this.deps.store.environments.computerOf(botId) ?? record) === "container";
    return createSandboxEnvironment(record, this.workspace(botId), {
      useWorkspaceFallback: () => (isContainer() || !this.vms.available) && this.status(botId)?.state !== "running",
      runtimeUnavailable: () => isContainer() ? !this.available : !(this.vms.available || this.hasRemoteCompute("vm")),
      unavailableFault: () => this.unavailable(503), runInSandbox: run, close: () => this.disconnect(botId),
    });
  }
  private connect(botId: string, record: EnvironmentRecord): Promise<WorkEnvironment> {
    const existing = this.connections.get(botId) ?? this.connecting.get(botId);
    if (existing) return Promise.resolve(existing);
    const gen = this.epoch.get(botId) ?? 0;
    const task = this.openConnection(botId, record, gen).finally(() => { if (this.connecting.get(botId) === task) this.connecting.delete(botId); });
    this.connecting.set(botId, task);
    return task;
  }
  private async openConnection(botId: string, record: EnvironmentRecord, gen: number): Promise<WorkEnvironment> {
    const check = () => {
      if (this.closed) throw new RuntimeFault("stopping", "Shutting down.", 503);
      if ((this.epoch.get(botId) ?? 0) !== gen) throw new RuntimeFault("computer_failed", "Sandbox connection was interrupted.", 503);
    };
    check();
    if (computerType(record) === "vm") {
      await this.ensure(botId); check();
      if (this.connections.has(botId)) return this.connections.get(botId)!;
      const access = await this.libvirt.ensure(record, computerLimits(record), this.workspace(botId)); check();
      const env = this.connections.get(botId) ?? this.libvirt.environment(record, access, text => this.log(`[${botId.slice(0, 8)}] ${text}`));
      this.connections.set(botId, env); return env;
    }
    const container = await this.ensure(botId); check();
    await this.ensureHome(botId, container); check();
    const env = this.connections.get(botId) ?? containerEnvironment(record.id, container, text => this.log(`[${botId.slice(0, 8)}] ${text}`));
    this.connections.set(botId, env); return env;
  }
  private ensureHome(botId: string, container: string): Promise<void> {
    let home = this.homes.get(container);
    if (!home) {
      home = this.prepareContainer(container).catch(error => { this.homes.delete(container); this.log(`sandbox of ${botId} not set up: ${(error as Error).message}`); });
      this.homes.set(container, home);
    }
    return home;
  }
  private async prepareContainer(container: string): Promise<void> { await homeAtWorkspace(container); if (this.network) await addHost(container, HOST_NAME, this.network.gateway); }
  private async joinNetwork(): Promise<void> {
    const name = `jarvy-${this.tag.slice(0, 6)}`;
    this.network = { name, gateway: await ensureNetwork(name, { "jarvy.data": this.tag }) };
    const owned = new Set(this.deps.store.environments.computers().filter(c => computerType(c) === "container").map(c => c.spec.container));
    for (const [container, networks] of await containerNetworks(`jarvy.data=${this.tag}`)) {
      if (!owned.has(container) || networks.includes(name)) continue;
      await moveToNetwork(container, name).then(() => { this.homes.delete(container); this.log(`moved ${container} to ${name}`); })
        .catch(error => this.log(`moving ${container} to ${name} failed: ${(error as Error).message}`));
    }
  }
  async address(botId: string): Promise<string | null> {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return null;
    if (computerType(computer) === "vm") return this.libvirt.address(computer);
    if (!this.available) return null;
    const container = computer.spec.container!;
    return (await this.addresses()).get(container) ?? (await this.addresses(true)).get(container) ?? null;
  }
  async botAt(address: string): Promise<string | null> {
    const plain = address.replace(/^::ffff:/, "");
    const all = this.deps.store.environments.computers();
    const vmBot = await this.libvirt.botAt(plain, all.filter(c => computerType(c) === "vm"));
    if (vmBot) return vmBot;
    if (!this.available) return null;
    const find = (book: Map<string, string>) => [...book].find(([, value]) => value === plain)?.[0];
    const container = find(await this.addresses()) ?? find(await this.addresses(true));
    return container ? all.find(c => computerType(c) === "container" && c.spec.container === container)?.botId ?? null : null;
  }
  async portTarget(botId: string, port: number): Promise<{ host: string; port: number; connect?: () => Duplex } | null> {
    const remote = this.deps.compute?.portTarget(botId, port);
    if (remote) return remote;
    const host = await this.address(botId);
    return host ? { host, port } : null;
  }
  async listening(botId: string): Promise<Map<number, { loopbackOnly: boolean }> | null> {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer || this.status(botId)?.state !== "running") return null;
    const type = computerType(computer);
    if (this.useRemote(type)) return this.deps.compute!.listening(botId);
    if (type === "vm") return this.libvirt.listening(computer);
    return listeningPorts(computer.spec.container!);
  }
  get hostName(): string { return HOST_NAME; }
  private async addresses(fresh = false): Promise<Map<string, string>> {
    const age = this.book ? Date.now() - this.book.at : Infinity;
    if (this.book && (fresh ? age < 1000 : age < 5000)) return this.book.byName;
    this.book = { at: Date.now(), byName: await networkAddresses(this.network?.name ?? "bridge").catch(() => new Map<string, string>()) };
    return this.book.byName;
  }

  /** Makes sure the Bot's container or VM exists and runs, building its image/template first when needed. */
  ensure(botId: string): Promise<string> {
    const pending = this.preparing.get(botId);
    if (pending) return pending;
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return Promise.reject(new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404));
    const container = computer.spec.container!, type = computerType(computer);
    if (this.states.get(botId)?.state === "running") return Promise.resolve(container);
    if (type === "vm" ? this.vms.current.state !== "unavailable" : this.docker !== false) this.set(botId, { state: "preparing" });
    const task = (async () => {
      try {
        await this.start();
        if (this.useRemote(type)) {
          const placed = await this.deps.compute!.ensure(botId, computer);
          this.resized.delete(botId);
          return placed.container;
        }
        if (type === "vm") {
          const support = await this.vms.check();
          if (support.state !== "available") throw new RuntimeFault("vm_unavailable", this.sandboxProblem(botId) ?? "Virtual machines are not available on this machine.", 503);
          await this.libvirt.ensure(computer, computerLimits(computer), this.workspace(botId));
          this.resized.delete(botId);
          this.set(botId, { state: "running" });
          return container;
        }
        if (this.docker !== true) throw this.unavailable(503);
        const image = await this.images.ready();
        const state = await containerState(container);
        if (state === "missing") await runContainer({ name: container, image, workspace: this.workspace(botId),
          daemonDir: join(this.dataDir, "computers", "bin"), uid: this.uid, gid: this.gid, labels: { "jarvy.data": this.tag, "jarvy.bot": botId }, limits: computerLimits(computer),
          ...(this.network ? { network: this.network.name, hosts: { [HOST_NAME]: this.network.gateway } } : {}) });
        else if (state === "stopped") await startContainer(container);
        if (state !== "running") { this.homes.delete(container); this.book = null; this.resized.delete(botId); }
        this.set(botId, { state: "running" });
        return container;
      } catch (error) {
        if (error instanceof RuntimeFault && (error.code === "docker_unavailable" || error.code === "vm_unavailable")) { this.states.delete(botId); this.deps.changed(); }
        else this.set(botId, { state: "failed", error: error instanceof RuntimeFault ? error.code : "computer_failed" });
        this.log(`computer of ${botId} failed: ${(error as Error).message}`);
        if (error instanceof RuntimeFault) throw error;
        throw new RuntimeFault("computer_failed", `Your sandbox could not start: ${(error as Error).message}`, 503);
      }
    })().finally(() => this.preparing.delete(botId));
    this.preparing.set(botId, task);
    return task;
  }
  verifyRunning(record: EnvironmentRecord): string {
    const botId = record.botId;
    if (!botId) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    const current = this.deps.store.environments.computerOf(botId) ?? record, status = this.status(botId), type = computerType(current);
    if (!status) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    if ((type === "container" || !this.vms.available) && status.state !== "running") return `workspace:${botId}`;
    if (status.state === "unavailable") throw new RuntimeFault("vm_unavailable", this.sandboxProblem(botId) ?? "Virtual machines are not available on this machine.", 503);
    if (status.state !== "running") throw new ChatError(409, "Sandbox is not running", "sandbox_stopped");
    const remote = this.useRemote(type) ? this.deps.compute?.placement(botId) : null;
    return remote ? `remote:${remote.deviceId}:${remote.container}` : `${type}:${current.spec.container ?? ""}`;
  }
  async openFs(record: EnvironmentRecord): Promise<EnvironmentFs> {
    const sig = this.verifyRunning(record), botId = record.botId!, current = this.deps.store.environments.computerOf(botId) ?? record;
    if (sig.startsWith("workspace:")) { await this.deps.compute?.hydrateWorkspace(botId); return openWorkspaceFs(current.id, this.workspace(botId)); }
    if (sig.startsWith("remote:")) return this.deps.compute!.openFs(botId, current) ?? openWorkspaceFs(current.id, this.workspace(botId));
    if (computerType(current) === "vm") {
      const access = await this.libvirt.runningAccess(current);
      if (!access) throw new ChatError(409, "Sandbox is not running", "sandbox_stopped");
      return openSshFs(current.id, access, COMPUTER_CWD, COMPUTER_CWD, text => this.log(`[fs ${botId.slice(0, 8)}] ${text}`));
    }
    return openContainerFs(current.id, current.spec.container!, COMPUTER_CWD, COMPUTER_CWD, text => this.log(`[fs ${botId.slice(0, 8)}] ${text}`));
  }
  async openPty(record: EnvironmentRecord, options: PtyOpenOptions): Promise<{ pty: PtyHandle; cwd: string; shell: "bash" }> {
    const botId = record.botId;
    if (!botId) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    const current = this.deps.store.environments.computerOf(botId) ?? record, type = computerType(current), cwd = options.cwd && options.cwd.startsWith("/") ? options.cwd : COMPUTER_CWD;
    if (this.useRemote(type)) return this.deps.compute!.openPty(botId, current, options);
    if (type === "vm") {
      await this.ensure(botId);
      const access = await this.libvirt.ensure(current, computerLimits(current), this.workspace(botId));
      return { pty: await openSshPty(current.id, access, { ...options, cwd, argv: ["/bin/bash", "-l"] }, text => this.log(`[pty ${botId.slice(0, 8)}] ${text}`)), cwd, shell: "bash" };
    }
    const container = await this.ensure(botId);
    await this.ensureHome(botId, container);
    return { pty: await openContainerPty(container, { ...options, cwd, argv: ["/bin/bash", "-l"] }, text => this.log(`[pty ${botId.slice(0, 8)}] ${text}`)), cwd, shell: "bash" };
  }
  async stop(botId: string): Promise<void> {
    const computer = this.record(botId);
    this.deps.onEnvironmentClosed?.(computer.id); await this.disconnect(botId);
    if (await this.deps.compute?.stop(botId)) return;
    if (computerType(computer) === "vm") await this.libvirt.stop(computer.spec.container!);
    else { if (this.docker !== true) throw this.unavailable(409); await stopContainer(computer.spec.container!); }
    this.resized.delete(botId); this.set(botId, { state: "stopped" });
  }
  async reset(botId: string): Promise<void> {
    const computer = this.record(botId);
    await this.settled(botId); this.deps.onEnvironmentClosed?.(computer.id); await this.disconnect(botId);
    if (await this.deps.compute?.reset(botId)) return;
    if (computerType(computer) === "vm") await this.libvirt.reset(computer);
    else { if (this.docker !== true) throw this.unavailable(409); await removeContainer(computer.spec.container!); }
    this.homes.delete(computer.spec.container!); this.resized.delete(botId); this.set(botId, { state: "stopped" });
  }
  async remove(botId: string, keepFiles = false): Promise<void> {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return;
    await this.settled(botId); this.deps.onEnvironmentClosed?.(computer.id); await this.disconnect(botId);
    await this.deps.compute?.remove(botId, keepFiles);
    if (computerType(computer) === "vm") await this.libvirt.remove(computer, computerLimits(computer), this.workspace(botId), keepFiles);
    else if (this.docker === true) await removeContainer(computer.spec.container!);
    this.deps.store.environments.dropComputer(botId); this.states.delete(botId);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer); if (this.recheck) clearTimeout(this.recheck);
    this.timer = null; this.recheck = null;
    await Promise.all([...this.connections.keys()].map(botId => this.disconnect(botId)));
    this.libvirt.close();
  }

  private unavailable(status: number): RuntimeFault { return dockerUnavailableFault(this.dockerProblem, status); }
  private workspace(botId: string): string { return join(this.dataDir, "bots", botId, "workspace"); }
  private record(botId: string): EnvironmentRecord { const c = this.deps.store.environments.computerOf(botId); if (!c) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404); return c; }
  private async settled(botId: string): Promise<void> { await this.preparing.get(botId)?.catch(() => {}); }
  private async disconnect(botId: string): Promise<void> {
    this.epoch.set(botId, (this.epoch.get(botId) ?? 0) + 1); this.connecting.delete(botId);
    const env = this.connections.get(botId); this.connections.delete(botId); await env?.close();
  }
  private set(botId: string, status: ComputerStatus): void {
    const before = this.states.get(botId); this.states.set(botId, status);
    if (before?.state !== status.state || before?.error !== status.error) this.deps.changed();
  }
  private async sweep(): Promise<void> {
    const computers = this.deps.store.environments.computers();
    const containerOwned = new Set(computers.filter(c => computerType(c) === "container").map(c => c.spec.container!));
    const vmOwned = new Set(computers.filter(c => computerType(c) === "vm").map(c => c.spec.container!));
    const dockerStates = this.docker === true ? await containerStates(`jarvy.data=${this.tag}`).catch(() => new Map<string, "running" | "stopped" | "missing">()) : new Map();
    for (const name of dockerStates.keys()) if (!containerOwned.has(name)) {
      this.log(`removing ${name}, which no Bot has`);
      await removeContainer(name).catch(error => this.log(`removing ${name} failed: ${(error as Error).message}`));
    }
    const vmStates = this.vms.available ? await this.libvirt.sweep(vmOwned).catch(() => new Map<string, "running" | "stopped" | "missing">()) : new Map();
    for (const computer of computers) {
      const botId = computer.botId!, type = computerType(computer);
      if (this.preparing.has(botId) || (type === "vm" && !this.vms.available) || (type === "container" && this.docker !== true)) continue;
      const running = (type === "vm" ? vmStates : dockerStates).get(computer.spec.container!) === "running";
      if (!running) { if (this.states.get(botId)?.state !== "failed") this.set(botId, { state: "stopped" }); this.resized.delete(botId); await this.disconnect(botId); continue; }
      if (type === "container" && this.states.get(botId)?.state !== "running") this.homes.delete(computer.spec.container!);
      this.set(botId, { state: "running" });
    }
  }
  private log(text: string): void { (this.deps.log ?? console.log)(`[computers] ${text}`); }
}
