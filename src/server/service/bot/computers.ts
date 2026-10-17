import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Store } from "../../infra/storage/store.js";
import {
  COMPUTER_CWD, buildImage, computerImage, containerEnvironment, containerState, containerStates, dockerAvailable, imageExists,
  pruneImages, removeContainer, runContainer, startContainer, stopContainer, syncDaemon,
} from "../../infra/env/docker.js";
import type { ComputerStatus, EnvironmentRecord, WorkEnvironment } from "../../shared/environment.js";
import { RuntimeFault } from "../../shared/runtime.js";

/** A computer nobody used for this long is stopped; the next tool call starts it again. */
const IDLE_MS = 60 * 60_000;
const SWEEP_MS = 60_000;

export interface ComputerDependencies {
  store: Store;
  /** A computer's state changed: the owner's page reloads the Bots. */
  changed: () => void;
  /** Whether the Bot is in a turn, when its computer must not be stopped for idling. */
  busy: (botId: string) => boolean;
  log?: (text: string) => void;
}

/** Bots' sandboxes (A50): Docker containers from an image built here, each mounting its Bot's workspace as
 * /workspace and running as the owner's ids. Made when first used, stopped when idle, removed with the Bot; a reset
 * removes the container and what was installed in it, never the workspace. Containers keep running when Jarvy stops,
 * so background work survives a restart. */
export class Computers {
  private docker: boolean | null = null;
  private probing: Promise<void> | null = null;
  private image: Promise<string> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly states = new Map<string, ComputerStatus>();
  private readonly preparing = new Map<string, Promise<string>>();
  private readonly used = new Map<string, number>();
  private readonly connections = new Map<string, WorkEnvironment>();
  private readonly dataDir: string;
  /** Tells this Jarvy's containers from those of other data directories on the same Docker. */
  private readonly tag: string;
  private readonly uid = process.getuid?.() ?? 1000;
  private readonly gid = process.getgid?.() ?? 1000;

  constructor(private readonly deps: ComputerDependencies) {
    this.dataDir = dirname(deps.store.path);
    this.tag = createHash("sha256").update(this.dataDir).digest("hex").slice(0, 12);
  }

  /** Looks for Docker and learns the state of every computer, once; every computer waits for it. */
  start(): Promise<void> {
    this.probing ??= this.probe();
    return this.probing;
  }
  private async probe(): Promise<void> {
    this.docker = await dockerAvailable();
    if (!this.docker) return;
    try { await syncDaemon(join(this.dataDir, "computers", "bin")); }
    catch (error) { this.docker = false; this.log(`computers disabled: ${(error as Error).message}`); return; }
    await this.sweep().catch(error => this.log(`computer sweep failed: ${(error as Error).message}`));
    this.timer = setInterval(() => void this.sweep().catch(error => this.log(`computer sweep failed: ${(error as Error).message}`)), SWEEP_MS);
    this.timer.unref();
  }
  /** Whether new computers can be made here; false until `start` found Docker. */
  get available(): boolean { return this.docker === true; }
  status(botId: string): ComputerStatus | null {
    if (!this.deps.store.environments.computerOf(botId)) return null;
    if (!this.available) return { state: "unavailable" };
    return this.states.get(botId) ?? { state: "stopped" };
  }

  /** Gives a Bot its computer and makes it the Bot's default environment; the container is made in the background. */
  create(botId: string): void {
    if (!this.available) throw new RuntimeFault("docker_unavailable", "Docker is not available on this machine.", 409);
    const computer = this.deps.store.environments.addComputer(botId, `jarvy-${this.tag.slice(0, 6)}-${botId.slice(0, 8)}`);
    this.deps.store.environments.setHome(botId, computer.id);
    void this.ensure(botId).catch(() => {});
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
      id: record.id, kind: "computer", cwd: COMPUTER_CWD,
      exec: (command, options) => run(env => env.exec(command, options)),
      readFile: path => run(env => env.readFile(path)),
      head: (path, bytes) => run(env => env.head(path, bytes)),
      writeFile: (path, content) => run(env => env.writeFile(path, content)),
      mkdir: path => run(env => env.mkdir(path)),
      exists: path => run(env => env.exists(path)),
      fileSize: path => run(env => env.fileSize(path)),
      close: () => this.disconnect(botId),
    };
  }
  private async connect(botId: string, record: EnvironmentRecord): Promise<WorkEnvironment> {
    const container = await this.ensure(botId);
    let env = this.connections.get(botId);
    if (!env) { env = containerEnvironment(record.id, container, text => this.log(`[${botId.slice(0, 8)}] ${text}`)); this.connections.set(botId, env); }
    return env;
  }

  /** Makes sure the container exists and runs, building the image first when needed; returns its name. */
  ensure(botId: string): Promise<string> {
    const pending = this.preparing.get(botId);
    if (pending) return pending;
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return Promise.reject(new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404));
    const container = computer.spec.container!;
    this.used.set(botId, Date.now());
    if (this.states.get(botId)?.state === "running") return Promise.resolve(container);
    if (this.docker !== false) this.set(botId, { state: "preparing" });
    const task = (async () => {
      try {
        await this.start();
        if (!this.available) throw new RuntimeFault("docker_unavailable", "Docker is not available on this machine.", 503);
        const image = await this.imageReady();
        const state = await containerState(container);
        if (state === "missing") await runContainer({ name: container, image, workspace: join(this.dataDir, "bots", botId, "workspace"),
          daemonDir: join(this.dataDir, "computers", "bin"), uid: this.uid, gid: this.gid, labels: { "jarvy.data": this.tag, "jarvy.bot": botId } });
        else if (state === "stopped") await startContainer(container);
        this.set(botId, { state: "running" });
        return container;
      } catch (error) {
        this.set(botId, { state: "failed", error: error instanceof RuntimeFault ? error.code : "computer_failed" });
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
    this.set(botId, { state: "stopped" });
  }
  /** Removes the container, so the next start makes a fresh one from the image: what was installed goes, the
   * workspace stays. */
  async reset(botId: string): Promise<void> {
    const computer = this.need(botId);
    await this.disconnect(botId);
    await removeContainer(computer.spec.container!);
    this.set(botId, { state: "stopped" });
  }
  /** The Bot is being deleted: its container goes with it. */
  async remove(botId: string): Promise<void> {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) return;
    await this.disconnect(botId);
    if (this.available) await removeContainer(computer.spec.container!);
    this.deps.store.environments.dropComputer(botId);
    this.states.delete(botId); this.used.delete(botId);
  }
  /** Closes the connections; containers keep running. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.connections.keys()].map(botId => this.disconnect(botId)));
  }

  private need(botId: string): EnvironmentRecord {
    const computer = this.deps.store.environments.computerOf(botId);
    if (!computer) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    if (!this.available) throw new RuntimeFault("docker_unavailable", "Docker is not available on this machine.", 409);
    return computer;
  }
  private imageReady(): Promise<string> {
    this.image ??= (async () => {
      const tag = computerImage(this.uid, this.gid);
      if (!(await imageExists(tag))) {
        this.log(`building ${tag}`);
        await buildImage(tag, this.uid, this.gid, join(this.dataDir, "computers", "build.log"));
        // Older images go once no container uses them: each is gigabytes.
        void pruneImages(tag).then(removed => { if (removed.length) this.log(`removed ${removed.join(", ")}`); }).catch(() => {});
      }
      return tag;
    })().catch(error => { this.image = null; throw error; });
    return this.image;
  }
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
  /** Learns what happened to containers outside Jarvy, stops computers left idle, and removes containers of this
   * Jarvy that no Bot has any more (a Bot deleted while Docker was out of reach). */
  private async sweep(): Promise<void> {
    const states = await containerStates(`jarvy.data=${this.tag}`);
    const now = Date.now(), computers = this.deps.store.environments.computers();
    const owned = new Set(computers.map(computer => computer.spec.container));
    for (const name of states.keys()) if (!owned.has(name)) {
      this.log(`removing ${name}, which no Bot has`);
      await removeContainer(name).catch(error => this.log(`removing ${name} failed: ${(error as Error).message}`));
    }
    for (const computer of computers) {
      const botId = computer.botId!;
      if (this.preparing.has(botId)) continue;
      const running = states.get(computer.spec.container!) === "running";
      if (!running) { if (this.states.get(botId)?.state !== "failed") this.set(botId, { state: "stopped" }); await this.disconnect(botId); continue; }
      if (!this.used.has(botId)) this.used.set(botId, now);
      if (now - this.used.get(botId)! > IDLE_MS && !this.deps.busy(botId)) {
        this.log(`stopping the idle computer of ${botId}`);
        await this.stop(botId).catch(error => this.log(`stopping ${botId} failed: ${(error as Error).message}`));
      } else this.set(botId, { state: "running" });
    }
  }
  private log(text: string): void { (this.deps.log ?? console.log)(`[computers] ${text}`); }
}
