import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import type { Store } from "../../infra/storage/store.js";
import {
  COMPUTER_CWD, addHost, containerEnvironment, containerNetworks, containerState, containerStates, containerUsage,
  dockerCapacity, dockerProblem, ensureNetwork, homeAtWorkspace, listeningPorts, moveToNetwork, networkAddresses,
  removeContainer, runContainer, startContainer, stopContainer, syncDaemon, updateLimits, type Capacity, type DockerProblem,
} from "../../infra/env/docker.js";
import { openContainerFs } from "../../infra/env/env-fs.js";
import { hostCapacity } from "../../infra/env/libvirt.js";
import { openSshFs, openSshPty } from "../../infra/env/ssh.js";
import { openContainerPty } from "../../infra/env/terminal.js";
import { ComputerImages, MIN_LIMITS, VmSandboxes, VmSupportCheck, computerLimits, computerType, dockerProblemMessage, parseComputerLimit, vmProblemMessage } from "./computer-vm.js";
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
  /** A computer's state changed: the owner's page reloads the Bots. */
  changed: () => void;
  /** A sandbox was stopped, reset, switched type or removed: drop any interactive terminals on it (A103). */
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
  /** Why this Bot's sandbox can't be used right now (Docker for containers, libvirt/KVM for VMs); null when ready. */
  sandboxProblem(botId: string): string | null {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return null;
    if (computerType(computer) !== "vm") return this.dockerProblem;
    if (this.vms.current.state !== "unavailable") return null;
    return vmProblemMessage(this.vms.reason, userInfo().username, this.vms.current.detail);
  }
  /** Whether Docker container sandboxes can run on this host. */
  get available(): boolean { return this.docker === true; }
  /** Whether this specific sandbox record's backend is available. */
  canRun(record: EnvironmentRecord): boolean { return computerType(record) === "vm" ? this.vms.available : this.available; }

  status(botId: string): ComputerStatus | null {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return null;
    if (computerType(computer) === "vm") {
      if (this.vms.current.state === "unavailable") return { state: "unavailable", error: this.vms.reason ?? "failed" };
      return this.states.get(botId) ?? { state: "stopped" };
    }
    if (!this.available) return { state: "unavailable", ...(this.problem ? { error: this.problem.reason } : {}) };
    return this.states.get(botId) ?? { state: "stopped" };
  }
  info(botId: string): ComputerInfo | null {
    const computer = this.deps.store.environments.computerOf(botId), status = this.status(botId);
    if (!computer || !status) return null;
    const type = computerType(computer);
    return { id: computer.id, ...status, type, container: computer.spec.container!, image: this.images.tag(type), workspace: this.workspace(botId), mount: COMPUTER_CWD,
      limits: computerLimits(computer), ...(this.resized.has(botId) ? { restartNeeded: true } : {}) };
  }
  get vmSupport(): VmSupport { return this.vms.current; }
  checkVms(again = false): Promise<VmSupport> { return this.vms.check(again); }

  /** Switches a Bot's sandbox between container and system VM (A101): preserves `/workspace` losslessly in both
   * directions (importing into `workspace.qcow2` on container→VM, exporting back to host before destroying on VM→container). */
  async setType(botId: string, type: ComputerType): Promise<void> {
    const computer = this.record(botId), current = computerType(computer);
    if (current === type) return;
    if (type === "vm") {
      const support = await this.vms.check();
      if (support.state !== "available") throw new ValidationError("This machine can't run VM sandboxes", "vm_unavailable", { reason: support.reason ?? "failed" });
    } else if (!this.available) {
      throw this.unavailable(409);
    }
    await this.settled(botId);
    this.deps.onEnvironmentClosed?.(computer.id);
    await this.disconnect(botId);
    if (current === "vm") {
      await this.libvirt.remove(computer, computerLimits(computer), this.workspace(botId), true);
    } else if (this.available) {
      await removeContainer(computer.spec.container!);
    }
    this.homes.delete(computer.spec.container!); this.resized.delete(botId);
    this.deps.store.environments.setType(computer.id, type);
    this.set(botId, { state: "stopped" });
    this.deps.changed();
  }

  async resources(botId: string): Promise<ComputerResources> {
    const computer = this.record(botId), name = computer.spec.container!, type = computerType(computer);
    const usage = this.status(botId)?.state !== "running" ? null
      : type === "vm" ? await this.libvirt.resources(computer).catch(() => null)
      : await containerUsage(name).catch(() => null);
    return { usage, capacity: await this.capacity(type).catch(() => null) };
  }

  async setLimits(botId: string, input: { memory: unknown; cpus: unknown }): Promise<void> {
    const computer = this.record(botId), type = computerType(computer), machine = await this.capacity(type), least = MIN_LIMITS[type];
    const memory = parseComputerLimit(input.memory, least.memory, machine.memory, 2 ** 20), cpus = parseComputerLimit(input.cpus, least.cpus, machine.cpus, type === "vm" ? 1 : 0.01);
    if (memory === undefined || cpus === undefined) throw new ValidationError("Limits are null or a number within this machine's size", type === "vm" ? "vm_size_invalid" : "limits_invalid",
      { memory: Math.floor(machine.memory / 2 ** 30 * 10) / 10, cpus: machine.cpus });
    const next = computerLimits({ ...computer, spec: { ...computer.spec, memory: memory === null ? "" : String(memory), cpus: cpus === null ? "" : String(cpus) } });
    const before = computerLimits(computer), change = { ...(next.memory !== before.memory ? { memory: next.memory } : {}), ...(next.cpus !== before.cpus ? { cpus: next.cpus } : {}) };
    if (Object.keys(change).length) {
      if (type === "vm") {
        const state = await this.libvirt.state(computer.spec.container!);
        if (state !== "missing") await this.libvirt.updateLimits(computer.spec.container!, next);
        if (state === "running") this.resized.add(botId);
      } else {
        if (!this.available) throw this.unavailable(409);
        const state = await containerState(computer.spec.container!);
        if (state !== "missing") await updateLimits(computer.spec.container!, change, machine);
      }
    }
    this.deps.store.environments.setLimits(computer.id, { memory, cpus });
    this.deps.changed();
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

  /** What the Bot's tools use while it works on its computer: every call first makes sure the sandbox runs. */
  environment(botId: string, record: EnvironmentRecord): WorkEnvironment {
    const run = async <T>(op: (env: WorkEnvironment) => Promise<T>): Promise<T> => {
      const current = this.deps.store.environments.computerOf(botId) ?? record;
      try { return await op(await this.connect(botId, current)); }
      catch (error) {
        if (error instanceof RuntimeFault) throw error;
        const alive = computerType(current) === "vm"
          ? await this.libvirt.state(current.spec.container!).catch(() => "missing") === "running"
          : await containerState(current.spec.container!).catch(() => "missing") === "running";
        if (alive) throw error;
        await this.disconnect(botId);
        this.set(botId, { state: "stopped" });
        return op(await this.connect(botId, current));
      }
    };
    return {
      id: record.id, kind: "computer", local: false, cwd: COMPUTER_CWD,
      exec: (command, options) => run(env => env.exec(command, options)),
      readFile: path => run(env => env.readFile(path)),
      head: (path, bytes) => run(env => env.head(path, bytes)),
      readRange: (path, offset, length) => run(env => env.readRange(path, offset, length)),
      writeFile: (path, content) => run(env => env.writeFile(path, content)),
      appendFile: (path, content) => run(env => env.appendFile(path, content)),
      mkdir: path => run(env => env.mkdir(path)),
      exists: path => run(env => env.exists(path)),
      fileSize: path => run(env => env.fileSize(path)),
      close: () => this.disconnect(botId),
    };
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
      const access = await this.libvirt.ensure(record, computerLimits(record), this.workspace(botId));
      check();
      const env = this.connections.get(botId) ?? this.libvirt.environment(record, access, text => this.log(`[${botId.slice(0, 8)}] ${text}`));
      this.connections.set(botId, env);
      return env;
    }
    const container = await this.ensure(botId); check();
    await this.ensureHome(botId, container); check();
    const env = this.connections.get(botId) ?? containerEnvironment(record.id, container, text => this.log(`[${botId.slice(0, 8)}] ${text}`));
    this.connections.set(botId, env);
    return env;
  }
  private ensureHome(botId: string, container: string): Promise<void> {
    let home = this.homes.get(container);
    if (!home) {
      home = this.prepareContainer(container).catch(error => { this.homes.delete(container); this.log(`sandbox of ${botId} not set up: ${(error as Error).message}`); });
      this.homes.set(container, home);
    }
    return home;
  }
  private async prepareContainer(container: string): Promise<void> {
    await homeAtWorkspace(container);
    if (this.network) await addHost(container, HOST_NAME, this.network.gateway);
  }
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
  async listening(botId: string): Promise<Map<number, { loopbackOnly: boolean }> | null> {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer || this.status(botId)?.state !== "running") return null;
    if (computerType(computer) === "vm") return this.libvirt.listening(computer);
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
        if (type === "vm") {
          const support = await this.vms.check();
          if (support.state !== "available") throw new RuntimeFault("vm_unavailable", this.sandboxProblem(botId) ?? "Virtual machines are not available on this machine.", 503);
          await this.libvirt.ensure(computer, computerLimits(computer), this.workspace(botId));
          this.resized.delete(botId);
          this.set(botId, { state: "running" });
          return container;
        }
        if (!this.available) throw this.unavailable(503);
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
  /** Checks whether a Bot's sandbox is currently running and reachable for file browsing (A104). */
  verifyRunning(record: EnvironmentRecord): string {
    const botId = record.botId;
    if (!botId) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    const current = this.deps.store.environments.computerOf(botId) ?? record, status = this.status(botId);
    if (!status) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    if (status.state === "unavailable") {
      if (computerType(current) === "vm") throw new RuntimeFault("vm_unavailable", this.sandboxProblem(botId) ?? "Virtual machines are not available on this machine.", 503);
      throw this.unavailable(503);
    }
    if (status.state !== "running") throw new ChatError(409, "Sandbox is not running", "sandbox_stopped");
    return `${computerType(current)}:${current.spec.container ?? ""}`;
  }
  /** Opens a dedicated file-browser `EnvironmentFs` into an already-running container or VM sandbox (A104). */
  async openFs(record: EnvironmentRecord): Promise<EnvironmentFs> {
    this.verifyRunning(record);
    const botId = record.botId!, current = this.deps.store.environments.computerOf(botId) ?? record;
    if (computerType(current) === "vm") {
      const access = await this.libvirt.runningAccess(current);
      if (!access) throw new ChatError(409, "Sandbox is not running", "sandbox_stopped");
      return openSshFs(current.id, access, COMPUTER_CWD, COMPUTER_CWD, text => this.log(`[fs ${botId.slice(0, 8)}] ${text}`));
    }
    return openContainerFs(current.id, current.spec.container!, COMPUTER_CWD, COMPUTER_CWD, text => this.log(`[fs ${botId.slice(0, 8)}] ${text}`));
  }
  /** Opens an interactive PTY in a Bot's container or VM sandbox, starting it first when stopped (A103). */
  async openPty(record: EnvironmentRecord, options: PtyOpenOptions): Promise<{ pty: PtyHandle; cwd: string; shell: "bash" }> {
    const botId = record.botId;
    if (!botId) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    const current = this.deps.store.environments.computerOf(botId) ?? record, cwd = options.cwd && options.cwd.startsWith("/") ? options.cwd : COMPUTER_CWD;
    if (computerType(current) === "vm") {
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
    this.deps.onEnvironmentClosed?.(computer.id);
    await this.disconnect(botId);
    if (computerType(computer) === "vm") await this.libvirt.stop(computer.spec.container!);
    else { if (!this.available) throw this.unavailable(409); await stopContainer(computer.spec.container!); }
    this.resized.delete(botId);
    this.set(botId, { state: "stopped" });
  }
  async reset(botId: string): Promise<void> {
    const computer = this.record(botId);
    await this.settled(botId);
    this.deps.onEnvironmentClosed?.(computer.id);
    await this.disconnect(botId);
    if (computerType(computer) === "vm") await this.libvirt.reset(computer);
    else { if (!this.available) throw this.unavailable(409); await removeContainer(computer.spec.container!); }
    this.homes.delete(computer.spec.container!); this.resized.delete(botId);
    this.set(botId, { state: "stopped" });
  }
  async remove(botId: string, keepFiles = false): Promise<void> {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return;
    await this.settled(botId);
    this.deps.onEnvironmentClosed?.(computer.id);
    await this.disconnect(botId);
    if (computerType(computer) === "vm") await this.libvirt.remove(computer, computerLimits(computer), this.workspace(botId), keepFiles);
    else if (this.available) await removeContainer(computer.spec.container!);
    this.deps.store.environments.dropComputer(botId);
    this.states.delete(botId);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.recheck) clearTimeout(this.recheck);
    this.timer = null; this.recheck = null;
    await Promise.all([...this.connections.keys()].map(botId => this.disconnect(botId)));
    this.libvirt.close();
  }

  private unavailable(status: number): RuntimeFault {
    const problem = this.dockerProblem;
    return new RuntimeFault("docker_unavailable", problem ? `${problem[0]!.toUpperCase()}${problem.slice(1)}.` : "Docker is not available on this machine.", status);
  }
  private workspace(botId: string): string { return join(this.dataDir, "bots", botId, "workspace"); }
  private record(botId: string): EnvironmentRecord {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    return computer;
  }
  private async settled(botId: string): Promise<void> { await this.preparing.get(botId)?.catch(() => {}); }
  private async disconnect(botId: string): Promise<void> {
    this.epoch.set(botId, (this.epoch.get(botId) ?? 0) + 1);
    this.connecting.delete(botId);
    const env = this.connections.get(botId);
    this.connections.delete(botId);
    await env?.close();
  }
  private set(botId: string, status: ComputerStatus): void {
    const before = this.states.get(botId);
    this.states.set(botId, status);
    if (before?.state !== status.state || before?.error !== status.error) this.deps.changed();
  }
  private async sweep(): Promise<void> {
    const computers = this.deps.store.environments.computers();
    const containerOwned = new Set(computers.filter(c => computerType(c) === "container").map(c => c.spec.container!));
    const vmOwned = new Set(computers.filter(c => computerType(c) === "vm").map(c => c.spec.container!));
    const dockerStates = this.available ? await containerStates(`jarvy.data=${this.tag}`).catch(() => new Map<string, "running" | "stopped" | "missing">()) : new Map();
    for (const name of dockerStates.keys()) if (!containerOwned.has(name)) {
      this.log(`removing ${name}, which no Bot has`);
      await removeContainer(name).catch(error => this.log(`removing ${name} failed: ${(error as Error).message}`));
    }
    const vmStates = this.vms.available ? await this.libvirt.sweep(vmOwned).catch(() => new Map<string, "running" | "stopped" | "missing">()) : new Map();
    for (const computer of computers) {
      const botId = computer.botId!, type = computerType(computer);
      if (this.preparing.has(botId)) continue;
      if (type === "vm" && !this.vms.available) continue;
      if (type === "container" && !this.available) continue;
      const running = (type === "vm" ? vmStates : dockerStates).get(computer.spec.container!) === "running";
      if (!running) { if (this.states.get(botId)?.state !== "failed") this.set(botId, { state: "stopped" }); this.resized.delete(botId); await this.disconnect(botId); continue; }
      if (type === "container" && this.states.get(botId)?.state !== "running") this.homes.delete(computer.spec.container!);
      this.set(botId, { state: "running" });
    }
  }
  private log(text: string): void { (this.deps.log ?? console.log)(`[computers] ${text}`); }
}
