import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Store } from "../../infra/storage/store.js";
import {
  COMPUTER_CWD, addHost, containerEnvironment, containerNetworks, containerState, containerStates, containerUsage,
  dockerCapacity, dockerProblem, ensureNetwork, homeAtWorkspace, listeningPorts, moveToNetwork, networkAddresses,
  removeContainer, runContainer, startContainer, stopContainer, syncDaemon, updateLimits, type Capacity, type DockerProblem,
} from "../../infra/env/docker.js";
import { createDisk, dockerUp, hostResolvers, removeDisk, trimDisk, useResolvers, vmHostUse, vmUsage } from "../../infra/env/kata.js";
import { ComputerImages, VM_SIZE, VmSupportCheck, computerType, vmDisk } from "./computer-vm.js";
import { userInfo } from "node:os";
import type { EnvironmentRecord, WorkEnvironment } from "../../shared/environment.js";
import type { ComputerInfo, ComputerLimits, ComputerResources, ComputerStatus, ComputerType, VmSupport } from "../../../contract/environment.js";
import { RuntimeFault } from "../../shared/runtime.js";
import { ValidationError } from "../../shared/errors.js";

const SWEEP_MS = 60_000;
/** How often Jarvy looks for Docker again while it can't be used, so fixing it needs no restart. */
const RECHECK_MS = 30_000;
/** The name sandboxes reach this machine by (A74), as Docker Desktop calls it. */
export const HOST_NAME = "host.docker.internal";
/** The least a limit may be (A75): less leaves too little for the tools' own daemon, or in a VM (A85) for its kernel
 * and Docker. */
const MIN = { container: { memory: 256 * 2 ** 20, cpus: 0.1 }, vm: { memory: 2 ** 30, cpus: 1 } } as const;
/** A computer's limits as kept with it (A75); none when absent. A VM (A85) always has a size, its default where none
 * was set. */
export function computerLimits(record: EnvironmentRecord): ComputerLimits {
  const read = (value: string | undefined) => value && Number(value) > 0 ? Number(value) : null;
  const memory = read(record.spec.memory), cpus = read(record.spec.cpus);
  return computerType(record) === "vm" ? { memory: memory ?? VM_SIZE.memory, cpus: cpus ?? VM_SIZE.cpus } : { memory, cpus };
}

export interface ComputerDependencies {
  store: Store;
  /** A computer's state changed: the owner's page reloads the Bots. */
  changed: () => void;
  log?: (text: string) => void;
}

/** Bots' sandboxes (A50): Docker containers from an image built here, each mounting its Bot's workspace as
 * /workspace and running as the owner's ids. Made when first used and kept running until the owner stops it, since
 * stopping closes what the Bot left running; removed with the Bot; a reset removes the container
 * and what was installed in it, never the workspace. Containers keep running when Jarvy stops, so background work
 * survives a restart. They share a network of this Jarvy's (A74), on which they reach this machine and beyond but not
 * each other; a published port is how one Bot's service is reached. */
export class Computers {
  private docker: boolean | null = null;
  /** Why Docker can't be used, while it can't. */
  private problem: DockerProblem | null = null;
  private recheck: NodeJS.Timeout | null = null;
  private closed = false;
  private probing: Promise<void> | null = null;
  private readonly images: ComputerImages;
  /** Whether VM sandboxes can be used here (A85). */
  private readonly vms: VmSupportCheck;
  /** VM sandboxes resized while they ran: the new size comes with their next start. */
  private readonly resized = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly states = new Map<string, ComputerStatus>();
  private readonly preparing = new Map<string, Promise<string>>();
  private readonly connections = new Map<string, WorkEnvironment>();
  /** Containers set up since they last started: their home checked (`homeAtWorkspace`), and the host's name added. */
  private readonly homes = new Map<string, Promise<void>>();
  /** This Jarvy's network and this machine's address on it; null on Docker's default bridge, if it couldn't be made. */
  private network: { name: string; gateway: string } | null = null;
  /** Running containers' addresses, by name, as last read. */
  private book: { at: number; byName: Map<string, string> } | null = null;
  /** This machine's CPUs and memory, asked of Docker once. */
  private machine: Promise<Capacity> | null = null;
  private readonly dataDir: string;
  /** Tells this Jarvy's containers from those of other data directories on the same Docker. */
  private readonly tag: string;
  private readonly uid = process.getuid?.() ?? 1000;
  private readonly gid = process.getgid?.() ?? 1000;

  constructor(private readonly deps: ComputerDependencies) {
    this.dataDir = dirname(deps.store.path);
    this.tag = createHash("sha256").update(this.dataDir).digest("hex").slice(0, 12);
    this.images = new ComputerImages(this.dataDir, this.uid, this.gid, text => this.log(text));
    this.vms = new VmSupportCheck(this.images, text => this.log(text));
  }

  /** Looks for Docker and learns the state of every computer; every computer waits for the first look. While Docker
   * can't be used, it looks again every 30 seconds and takes it up once it can. */
  start(): Promise<void> {
    this.probing ??= this.probe();
    return this.probing;
  }
  private async probe(): Promise<void> {
    const problem = await dockerProblem();
    if (problem) return this.unusable(problem);
    try { await syncDaemon(join(this.dataDir, "computers", "bin")); }
    catch (error) { return this.unusable({ reason: "failed", detail: `the tools' daemon could not be put in place: ${(error as Error).message}` }); }
    const found = this.docker === false;
    this.docker = true; this.problem = null;
    if (found) this.log("Docker can be used now");
    await this.joinNetwork().catch(error => this.log(`sandbox network unavailable, staying on the default bridge: ${(error as Error).message}`));
    await this.sweep().catch(error => this.log(`computer sweep failed: ${(error as Error).message}`));
    this.timer = setInterval(() => void this.sweep().catch(error => this.log(`computer sweep failed: ${(error as Error).message}`)), SWEEP_MS);
    this.timer.unref();
    if (found) this.deps.changed();
  }
  /** Docker can't be used: said once in the log per reason, and looked for again later. */
  private unusable(problem: DockerProblem): void {
    const before = this.docker === null ? null : this.problem?.reason;
    if (before !== problem.reason) this.log(`Docker can't be used (${problem.reason}): ${problem.detail}`);
    this.docker = false; this.problem = problem;
    // Another reason than before: Bot info says it.
    if (before && before !== problem.reason) this.deps.changed();
    if (this.closed) return;
    this.recheck = setTimeout(() => { this.recheck = null; void this.probe(); }, RECHECK_MS);
    this.recheck.unref();
  }
  /** Why Docker can't be used, in a Bot's words; null when it can, or before Jarvy has looked. */
  get dockerProblem(): string | null {
    const problem = this.docker === false ? this.problem : null;
    if (!problem) return null;
    if (problem.reason === "missing") return "Docker isn't installed on the computer running Jarvy";
    if (problem.reason === "stopped") return "Docker is installed on the computer running Jarvy but isn't running";
    if (problem.reason === "denied") return `Docker on the computer running Jarvy refuses the user Jarvy runs as (${userInfo().username})`;
    return `Docker on the computer running Jarvy can't be used (${problem.detail})`;
  }
  /** Whether new computers can be made here; false until `start` found Docker. */
  get available(): boolean { return this.docker === true; }
  status(botId: string): ComputerStatus | null {
    if (!this.deps.store.environments.computerOf(botId)) return null;
    if (!this.available) return { state: "unavailable", ...(this.problem ? { error: this.problem.reason } : {}) };
    return this.states.get(botId) ?? { state: "stopped" };
  }
  /** The sandbox as Bot info shows it: its state, and the container, image and workspace folder it is made of. */
  info(botId: string): ComputerInfo | null {
    const computer = this.deps.store.environments.computerOf(botId), status = this.status(botId);
    if (!computer || !status) return null;
    const type = computerType(computer);
    return { ...status, type, container: computer.spec.container!, image: this.images.tag(type), workspace: this.workspace(botId), mount: COMPUTER_CWD,
      limits: computerLimits(computer), ...(this.resized.has(botId) ? { restartNeeded: true } : {}) };
  }
  /** Whether VM sandboxes can be used here, as last checked (A85). */
  get vmSupport(): VmSupport { return this.available ? this.vms.current : { state: "unavailable", reason: "failed", detail: this.dockerProblem ?? "Docker can't be used" }; }
  /** Checks whether VM sandboxes can be used here: the first time when asked, or `again`. */
  checkVms(again = false): Promise<VmSupport> { return this.available ? this.vms.check(again) : Promise.resolve(this.vmSupport); }
  /** Makes the Bot's sandbox a container or a VM (A85). Like a reset, what was installed goes and the workspace stays;
   * a VM's Docker disk goes too. The next start makes the new one. */
  async setType(botId: string, type: ComputerType): Promise<void> {
    const computer = this.need(botId);
    if (computerType(computer) === type) return;
    if (type === "vm") {
      const support = await this.vms.check();
      if (support.state !== "available") throw new ValidationError("This machine can't run VM sandboxes", "vm_unavailable", { reason: support.reason ?? "failed" });
    }
    await this.settled(botId);
    await this.disconnect(botId);
    await removeContainer(computer.spec.container!);
    await removeDisk(vmDisk(this.dataDir, computer.spec.container!));
    this.homes.delete(computer.spec.container!); this.resized.delete(botId);
    this.deps.store.environments.setType(computer.id, type);
    this.set(botId, { state: "stopped" });
    this.deps.changed();
  }
  /** What the sandbox uses now, when it runs, and what this machine has; null for what Docker doesn't answer. A VM's
   * is read inside it (A85), since Docker counts only its container's processes, with what it takes of this machine. */
  async resources(botId: string): Promise<ComputerResources> {
    const computer = this.need(botId), name = computer.spec.container!;
    const usage = this.status(botId)?.state !== "running" ? null : computerType(computer) === "vm"
      ? await Promise.all([vmUsage(name), vmHostUse(name, vmDisk(this.dataDir, name))]).then(([use, host]) => ({ ...use, host })).catch(() => null)
      : await containerUsage(name).catch(() => null);
    return { usage, capacity: await this.capacity().catch(() => null) };
  }
  /** Sets what the sandbox may use at most (A75): a container that exists changes at once, running or not, and one made
   * later, after a reset too, starts with them. Each is null for no limit, or from a floor up to this machine's size. */
  async setLimits(botId: string, input: { memory: unknown; cpus: unknown }): Promise<void> {
    const computer = this.need(botId), machine = await this.capacity(), type = computerType(computer), least = MIN[type];
    const memory = limit(input.memory, least.memory, machine.memory, 2 ** 20), cpus = limit(input.cpus, least.cpus, machine.cpus, 0.01);
    if (memory === undefined || cpus === undefined) throw new ValidationError("Limits are null or a number within this machine's size", type === "vm" ? "vm_size_invalid" : "limits_invalid",
      { memory: Math.floor(machine.memory / 2 ** 30 * 10) / 10, cpus: machine.cpus });
    // Only what changed goes to the container: one never limited stays without limits. A VM's null is its default size.
    const next = computerLimits({ ...computer, spec: { ...computer.spec, memory: memory === null ? "" : String(memory), cpus: cpus === null ? "" : String(cpus) } });
    const before = computerLimits(computer), change = { ...(next.memory !== before.memory ? { memory: next.memory } : {}), ...(next.cpus !== before.cpus ? { cpus: next.cpus } : {}) };
    const state = Object.keys(change).length ? await containerState(computer.spec.container!) : "missing";
    if (state !== "missing") await updateLimits(computer.spec.container!, change, machine);
    // Docker keeps a VM's new size for its next start; the running VM keeps its own.
    if (type === "vm" && state === "running") this.resized.add(botId);
    this.deps.store.environments.setLimits(computer.id, { memory, cpus });
    this.deps.changed();
  }
  private capacity(): Promise<Capacity> {
    this.machine ??= dockerCapacity().catch(error => { this.machine = null; throw error; });
    return this.machine;
  }
  /** Every Bot has its computer (A68): one restored or made without one, such as the agent Bot on a new installation,
   * gets it now. */
  adopt(botIds: readonly string[]): void {
    for (const botId of botIds) if (!this.deps.store.environments.computerOf(botId)) this.create(botId);
  }

  /** Gives a Bot its computer and makes it the Bot's default environment; the container is made in the background
   * when Docker is there (A68). Without Docker the Bot keeps its computer as its default and still runs: only its file
   * and command tools fail until Docker is available, and chat works as usual. */
  create(botId: string): void {
    const computer = this.deps.store.environments.addComputer(botId, `jarvy-${this.tag.slice(0, 6)}-${botId.slice(0, 8)}`);
    this.deps.store.environments.setHome(botId, computer.id);
    if (this.available) void this.ensure(botId).catch(() => {});
  }
  /** What the Bot's tools use while it works on its computer: every call first makes sure the container runs. */
  environment(botId: string, record: EnvironmentRecord): WorkEnvironment {
    const run = async <T>(op: (env: WorkEnvironment) => Promise<T>): Promise<T> => {
      try { return await op(await this.connect(botId, record)); }
      catch (error) {
        if (error instanceof RuntimeFault || await containerState(record.spec.container!).catch(() => "missing") === "running") throw error;
        // The container was stopped or removed behind Jarvy's back: bring it back and try once more.
        await this.disconnect(botId);
        this.set(botId, { state: "stopped" });
        return op(await this.connect(botId, record));
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
  private async connect(botId: string, record: EnvironmentRecord): Promise<WorkEnvironment> {
    const container = await this.ensure(botId);
    let home = this.homes.get(container);
    if (!home) {
      home = this.prepare(container, computerType(record) === "vm").catch(error => { this.homes.delete(container); this.log(`sandbox of ${botId} not set up: ${(error as Error).message}`); });
      this.homes.set(container, home);
    }
    await home;
    let env = this.connections.get(botId);
    if (!env) { env = containerEnvironment(record.id, container, text => this.log(`[${botId.slice(0, 8)}] ${text}`)); this.connections.set(botId, env); }
    return env;
  }
  /** Sets up a container after it starts: the workspace as its home, this machine's name for one made before
   * containers got it at creation, and in a VM (A85) Docker on its disk, which gives back what Docker frees. A disk not
   * trimmed is said in the log and doesn't stop the Bot working. */
  private async prepare(container: string, vm: boolean): Promise<void> {
    await homeAtWorkspace(container);
    if (this.network) await addHost(container, HOST_NAME, this.network.gateway);
    if (vm) {
      await useResolvers(container, hostResolvers()); await dockerUp(container);
      await trimDisk(container).catch(error => this.log(`Docker disk of ${container} not trimmed: ${(error as Error).message}`));
    }
  }
  /** Makes this Jarvy's network and moves the containers still on Docker's default bridge there, running or not. */
  private async joinNetwork(): Promise<void> {
    const name = `jarvy-${this.tag.slice(0, 6)}`;
    this.network = { name, gateway: await ensureNetwork(name, { "jarvy.data": this.tag }) };
    const owned = new Set(this.deps.store.environments.computers().map(computer => computer.spec.container));
    for (const [container, networks] of await containerNetworks(`jarvy.data=${this.tag}`)) {
      if (!owned.has(container) || networks.includes(name)) continue;
      await moveToNetwork(container, name).then(() => { this.homes.delete(container); this.log(`moved ${container} to ${name}`); })
        .catch(error => this.log(`moving ${container} to ${name} failed: ${(error as Error).message}`));
    }
  }
  /** The address a Bot's running sandbox has on the network, or null. */
  async address(botId: string): Promise<string | null> {
    const container = this.deps.store.environments.computerOf(botId)?.spec.container;
    if (!container || !this.available) return null;
    return (await this.addresses()).get(container) ?? (await this.addresses(true)).get(container) ?? null;
  }
  /** The Bot whose running sandbox has this address, if one of this Jarvy's has it. */
  async botAt(address: string): Promise<string | null> {
    if (!this.available) return null;
    const plain = address.replace(/^::ffff:/, "");
    const find = (book: Map<string, string>) => [...book].find(([, value]) => value === plain)?.[0];
    const container = find(await this.addresses()) ?? find(await this.addresses(true));
    return container ? this.deps.store.environments.computers().find(computer => computer.spec.container === container)?.botId ?? null : null;
  }
  /** The ports something listens on in a Bot's running sandbox; null when it isn't running. */
  async listening(botId: string): Promise<Map<number, { loopbackOnly: boolean }> | null> {
    const container = this.deps.store.environments.computerOf(botId)?.spec.container;
    if (!container || this.status(botId)?.state !== "running") return null;
    return listeningPorts(container);
  }
  /** How a sandbox names this machine. */
  get hostName(): string { return HOST_NAME; }
  /** Read again when asked fresh, at most once a second, so callers that miss don't each ask Docker. */
  private async addresses(fresh = false): Promise<Map<string, string>> {
    const age = this.book ? Date.now() - this.book.at : Infinity;
    if (this.book && (fresh ? age < 1000 : age < 5000)) return this.book.byName;
    this.book = { at: Date.now(), byName: await networkAddresses(this.network?.name ?? "bridge").catch(() => new Map<string, string>()) };
    return this.book.byName;
  }

  /** Makes sure the container exists and runs, building the image first when needed; returns its name. */
  ensure(botId: string): Promise<string> {
    const pending = this.preparing.get(botId);
    if (pending) return pending;
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return Promise.reject(new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404));
    const container = computer.spec.container!;
    if (this.states.get(botId)?.state === "running") return Promise.resolve(container);
    if (this.docker !== false) this.set(botId, { state: "preparing" });
    const task = (async () => {
      try {
        await this.start();
        if (!this.available) throw this.unavailable(503);
        const type = computerType(computer), image = await this.images.ready(type), disk = vmDisk(this.dataDir, container);
        if (type === "vm") await createDisk(disk);
        const state = await containerState(container);
        if (state === "missing") await runContainer({ name: container, image, workspace: this.workspace(botId),
          daemonDir: join(this.dataDir, "computers", "bin"), uid: this.uid, gid: this.gid, labels: { "jarvy.data": this.tag, "jarvy.bot": botId }, limits: computerLimits(computer),
          ...(this.network ? { network: this.network.name, hosts: { [HOST_NAME]: this.network.gateway } } : {}), ...(type === "vm" ? { vm: { disk } } : {}) });
        else if (state === "stopped") await startContainer(container);
        // Docker wrote its /etc/hosts afresh; a VM came up at its new size, without Docker running in it yet.
        if (state !== "running") { this.homes.delete(container); this.book = null; this.resized.delete(botId); }
        this.set(botId, { state: "running" });
        return container;
      } catch (error) {
        // Without Docker the sandbox didn't fail: it shows as unavailable, and as it is once Docker is found.
        if (error instanceof RuntimeFault && error.code === "docker_unavailable") { this.states.delete(botId); this.deps.changed(); }
        else this.set(botId, { state: "failed", error: error instanceof RuntimeFault ? error.code : "computer_failed" });
        this.log(`computer of ${botId} failed: ${(error as Error).message}`);
        if (error instanceof RuntimeFault) throw error;
        throw new RuntimeFault("computer_failed", `Your sandbox could not start: ${(error as Error).message}`, 503);
      }
    })().finally(() => this.preparing.delete(botId));
    this.preparing.set(botId, task);
    return task;
  }
  async stop(botId: string): Promise<void> {
    const computer = this.need(botId);
    await this.disconnect(botId);
    await stopContainer(computer.spec.container!);
    this.resized.delete(botId);
    this.set(botId, { state: "stopped" });
  }
  /** Removes the container, so the next start makes a fresh one from the image: what was installed goes, the
   * workspace stays. */
  async reset(botId: string): Promise<void> {
    const computer = this.need(botId);
    await this.settled(botId);
    await this.disconnect(botId);
    await removeContainer(computer.spec.container!);
    // A VM's Docker starts empty again (A85).
    await removeDisk(vmDisk(this.dataDir, computer.spec.container!));
    this.homes.delete(computer.spec.container!); this.resized.delete(botId);
    this.set(botId, { state: "stopped" });
  }
  /** The Bot is being deleted: its container goes with it. */
  async remove(botId: string): Promise<void> {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return;
    await this.disconnect(botId);
    if (this.available) await removeContainer(computer.spec.container!);
    await removeDisk(vmDisk(this.dataDir, computer.spec.container!));
    this.deps.store.environments.dropComputer(botId);
    this.states.delete(botId);
  }
  /** Closes the connections; containers keep running. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.recheck) clearTimeout(this.recheck);
    this.timer = null; this.recheck = null;
    await Promise.all([...this.connections.keys()].map(botId => this.disconnect(botId)));
  }

  private unavailable(status: number): RuntimeFault {
    const problem = this.dockerProblem;
    return new RuntimeFault("docker_unavailable", problem ? `${problem[0]!.toUpperCase()}${problem.slice(1)}.` : "Docker is not available on this machine.", status);
  }
  private workspace(botId: string): string { return join(this.dataDir, "bots", botId, "workspace"); }
  private need(botId: string): EnvironmentRecord {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    if (!this.available) throw this.unavailable(409);
    return computer;
  }
  /** Waits for a start under way, so a container it is making isn't made after the one replacing it is asked for. */
  private async settled(botId: string): Promise<void> { await this.preparing.get(botId)?.catch(() => {}); }
  private async disconnect(botId: string): Promise<void> {
    const env = this.connections.get(botId);
    this.connections.delete(botId);
    await env?.close();
  }
  private set(botId: string, status: ComputerStatus): void {
    const before = this.states.get(botId);
    this.states.set(botId, status);
    if (before?.state !== status.state || before?.error !== status.error) this.deps.changed();
  }
  /** Learns what happened to containers outside Jarvy, and removes containers of this Jarvy that no Bot has any more
   * (a Bot deleted while Docker was out of reach). */
  private async sweep(): Promise<void> {
    const states = await containerStates(`jarvy.data=${this.tag}`);
    const computers = this.deps.store.environments.computers();
    const owned = new Set(computers.map(computer => computer.spec.container));
    for (const name of states.keys()) if (!owned.has(name)) {
      this.log(`removing ${name}, which no Bot has`);
      await removeContainer(name).catch(error => this.log(`removing ${name} failed: ${(error as Error).message}`));
    }
    for (const computer of computers) {
      const botId = computer.botId!;
      if (this.preparing.has(botId)) continue;
      const running = states.get(computer.spec.container!) === "running";
      if (!running) { if (this.states.get(botId)?.state !== "failed") this.set(botId, { state: "stopped" }); this.resized.delete(botId); await this.disconnect(botId); continue; }
      // Started outside Jarvy: set it up again on next use.
      if (this.states.get(botId)?.state !== "running") this.homes.delete(computer.spec.container!);
      this.set(botId, { state: "running" });
    }
  }
  private log(text: string): void { (this.deps.log ?? console.log)(`[computers] ${text}`); }
}

/** A limit as asked: null for none; a number from `min` to `max`, rounded to `step`; undefined when it is neither. */
function limit(value: unknown, min: number, max: number, step: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value / step) * step;
  return rounded >= min && rounded <= max ? Number(rounded.toFixed(2)) : undefined;
}
