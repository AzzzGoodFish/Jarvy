import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, RemoteExecutionEnv, packagedDaemon } from "@earendil-works/pi-env";
import type { WorkEnvironment } from "../../shared/environment.js";
import type { DockerProblemReason } from "../../../contract/environment.js";
import { COMPUTER_DOCKERFILE, DOCKER_UP, VM_DISK, vmDockerfile } from "./computer-image.js";
import { overDurable } from "./durable.js";

/** Bots' sandboxes (A50): Docker containers from an image built on this machine, driven with the docker command
 * line. The tools reach a container through pi-env's daemon, started inside it by `docker exec -i`. */
export const COMPUTER_CWD = "/workspace";
const DAEMON_DIR = "/opt/jarvy";

export type ContainerState = "running" | "stopped" | "missing";
export interface ContainerSpec {
  name: string; image: string;
  /** The Bot's workspace on this machine, mounted as /workspace. */
  workspace: string;
  /** The directory holding the daemon, mounted read-only. */
  daemonDir: string;
  uid: number; gid: number;
  labels: Record<string, string>;
  /** The network it joins instead of Docker's default bridge (A74), and names it resolves, such as the host's. */
  network?: string; hosts?: Record<string, string>;
  /** What it may use at most (A75); none when absent. A VM's size (A85). */
  limits?: ResourceLimits;
  /** A VM sandbox (A85): run by Kata, with the Bot's Docker disk, a file of this machine. */
  vm?: { disk: string };
}
/** Memory in bytes and CPUs in cores; null is no limit. */
export interface ResourceLimits { memory: number | null; cpus: number | null }
/** A machine's CPUs and memory in bytes. */
export interface Capacity { cpus: number; memory: number }

/** Runs the docker command line; a failure says Docker's last line of error (not its hint to run `--help`), or how
 * the command ended when it said nothing. */
export function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout.trim());
    const said = stderr.trim().split("\n").filter(line => line.trim() && !/^Run 'docker .*--help'/.test(line)).at(-1);
    const ended = error.killed ? `docker ${args[0]} was stopped after ${timeoutMs / 1000} seconds` : `docker ${args[0]} exited with ${error.code ?? error.signal}`;
    reject(Object.assign(new Error(said ?? (stdout.trim().split("\n").at(-1) || ended)), { code: "docker_failed" }));
  }));
}

/** Why Docker can't be used here: no `docker` command, no daemon answering, the daemon refusing this user, or
 * something else (`detail` keeps what Docker said). */
export interface DockerProblem { reason: DockerProblemReason; detail: string }
/** Null when this user can use Docker; otherwise why not, told apart by what the docker command says. */
export function dockerProblem(): Promise<DockerProblem | null> {
  return new Promise(resolve => execFile("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 }, (error, _stdout, stderr) => {
    if (!error) return resolve(null);
    const said = (stderr || error.message).trim(), detail = said.split("\n").filter(Boolean).at(-1) ?? said;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") resolve({ reason: "missing", detail: "no docker command" });
    else if (/permission denied/i.test(said)) resolve({ reason: "denied", detail });
    else if (/cannot connect|failed to connect|daemon (is )?running|no such file|connection refused|error during connect/i.test(said)) resolve({ reason: "stopped", detail });
    else resolve({ reason: "failed", detail: error.killed ? "docker didn't answer within 10 seconds" : detail });
  }));
}

/** One image per Dockerfile and owner ids, named after both, so a change builds a new one. */
export function computerImage(uid: number, gid: number): string {
  return `jarvy-computer:${createHash("sha256").update(`${COMPUTER_DOCKERFILE}\n${uid}:${gid}`).digest("hex").slice(0, 12)}`;
}
/** A VM sandbox's image (A85), named after the sandbox image it is built on and what it adds. */
export function vmImage(base: string): string {
  return `jarvy-computer:vm-${createHash("sha256").update(`${vmDockerfile(base)}\n${DOCKER_UP}`).digest("hex").slice(0, 12)}`;
}
/** What a sandbox image is built from: its Dockerfile, the files it copies, and its build arguments. */
export interface ImageRecipe { dockerfile: string; files?: Record<string, string>; args?: Record<string, string> }
export const computerRecipe = (uid: number, gid: number): ImageRecipe => ({ dockerfile: COMPUTER_DOCKERFILE, args: { UID: String(uid), GID: String(gid) } });
export const vmRecipe = (base: string): ImageRecipe => ({ dockerfile: vmDockerfile(base), files: { "jarvy-docker-up": DOCKER_UP } });

/** Removes the other images of Bots' computers that no container uses; Docker refuses those still in use. */
export async function pruneImages(keep: readonly string[]): Promise<string[]> {
  const tags = (await docker(["images", "--filter", "label=jarvy.computer=1", "--format", "{{.Repository}}:{{.Tag}}"])).split("\n").filter(Boolean);
  const removed: string[] = [];
  for (const tag of tags) if (!keep.includes(tag)) {
    try { await docker(["image", "rm", tag], 120_000); removed.push(tag); }
    catch { /* a container still uses it */ }
  }
  return removed;
}

export async function imageExists(tag: string): Promise<boolean> {
  try { await docker(["image", "inspect", "--format", "{{.Id}}", tag]); return true; }
  catch { return false; }
}

/** Builds an image from its recipe alone; its output goes to `logFile`. Pulling the base takes minutes the first
 * time. */
export async function buildImage(tag: string, recipe: ImageRecipe, logFile: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jarvy-computer-"));
  try {
    await writeFile(join(dir, "Dockerfile"), recipe.dockerfile);
    // Files copied in keep their mode: scripts run.
    for (const [name, content] of Object.entries(recipe.files ?? {})) await writeFile(join(dir, name), content, { mode: 0o755 });
    const log = createWriteStream(logFile, { flags: "w", mode: 0o600 });
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("docker", ["build", "-t", tag, "--label", "jarvy.computer=1",
        ...Object.entries(recipe.args ?? {}).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]), dir], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => log.end());
    if (code !== 0) throw Object.assign(new Error(`docker build exited with ${code}`), { code: "docker_failed" });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The state of every container with this label, by name: one call for all of them. */
export async function containerStates(label: string): Promise<Map<string, ContainerState>> {
  const out = await docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}\t{{.State}}"]);
  const states = new Map<string, ContainerState>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [name, state] = line.split("\t");
    if (name) states.set(name, state === "running" ? "running" : "stopped");
  }
  return states;
}

export async function containerState(name: string): Promise<ContainerState> {
  try { return await docker(["inspect", "--format", "{{.State.Running}}", name]) === "true" ? "running" : "stopped"; }
  catch (error) {
    if (/no such (object|container)/i.test((error as Error).message)) return "missing";
    throw error;
  }
}

/** Creates and starts the container. It runs as the owner's ids and keeps running idle until stopped. */
export async function runContainer(spec: ContainerSpec): Promise<void> {
  await docker(["run", "-d", "--name", spec.name, "--init", "--user", `${spec.uid}:${spec.gid}`, "--shm-size", "1g",
    ...Object.entries(spec.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    ...(spec.network ? ["--network", spec.network] : []), ...Object.entries(spec.hosts ?? {}).flatMap(([name, address]) => ["--add-host", `${name}:${address}`]),
    ...(spec.limits?.memory ? memoryFlags(spec.limits.memory, spec.limits.memory) : []), ...(spec.limits?.cpus ? ["--cpus", String(spec.limits.cpus)] : []),
    ...(spec.vm ? vmFlags(spec.vm.disk) : []),
    "-v", `${spec.workspace}:${COMPUTER_CWD}`, "-v", `${spec.daemonDir}:${DAEMON_DIR}:ro`, "-w", COMPUTER_CWD,
    spec.image, "sleep", "infinity"], 120_000);
}
/** The runtime for VM sandboxes (A85): Kata's shim for containerd, found on the PATH of Docker's containerd. */
export const KATA_RUNTIME = "io.containerd.kata.v2";
/** A VM sandbox's flags (A85). The VM is the boundary, so what the container may do inside it is opened up — every
 * capability, no seccomp, AppArmor or masked system paths, loop devices — for Docker to run there; never
 * `--privileged`, which would hand it this machine's devices. Its user is in the docker group, and its disk is
 * mounted where DOCKER_UP looks. */
const vmFlags = (disk: string) => ["--runtime", KATA_RUNTIME, "--group-add", "docker", "--cap-add", "ALL",
  "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined", "--security-opt", "systempaths=unconfined",
  "--device-cgroup-rule", "b 7:* rmw", "--device-cgroup-rule", "c 10:237 rmw", "-v", `${disk}:${VM_DISK}`];
/** Memory and swap together: swap equal to memory leaves the container none, so a limit can't be got around. */
const memoryFlags = (memory: number, withSwap: number) => ["--memory", String(memory), "--memory-swap", String(withSwap)];
/** Changes the limits given, of a container running or not, at once (A75). Docker can't take a limit off a container,
 * so no limit there is the whole machine: all its CPUs, and its memory with as much swap again. Memory below what the
 * container uses makes the kernel end its largest processes. */
export async function updateLimits(name: string, change: Partial<ResourceLimits>, machine: Capacity): Promise<void> {
  const args = [...(change.memory === undefined ? [] : change.memory ? memoryFlags(change.memory, change.memory) : memoryFlags(machine.memory, machine.memory * 2)),
    ...(change.cpus === undefined ? [] : ["--cpus", String(change.cpus ?? machine.cpus)])];
  if (args.length) await docker(["update", ...args, name], 60_000);
}
/** The CPUs and memory of the machine Docker runs on. */
export async function dockerCapacity(): Promise<Capacity> {
  const [cpus, memory] = (await docker(["info", "--format", "{{.NCPU}} {{.MemTotal}}"], 15_000)).split(" ").map(Number);
  if (!cpus || !memory) throw Object.assign(new Error("docker info gave no CPUs or memory"), { code: "docker_failed" });
  return { cpus, memory };
}
/** What a running container uses now: memory in bytes, as `docker stats` counts it (without the reclaimable cache), and
 * CPU in percent of one core. Takes a second or two, as Docker samples the CPU twice. */
export async function containerUsage(name: string): Promise<{ memory: number; cpu: number }> {
  const [cpu = "", memory = ""] = (await docker(["stats", "--no-stream", "--format", "{{.CPUPerc}}\t{{.MemUsage}}", name], 30_000)).split("\t");
  return { cpu: parseFloat(cpu) || 0, memory: sizeBytes(memory.split("/")[0] ?? "") };
}
const UNITS: Record<string, number> = { b: 1, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
/** A size as Docker prints it, such as `421.5MiB`. */
function sizeBytes(text: string): number {
  const match = /^\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(text);
  return match ? Math.round(parseFloat(match[1]!) * (UNITS[match[2]!.toLowerCase()] ?? 1)) : 0;
}
export async function startContainer(name: string): Promise<void> { await docker(["start", name], 60_000); }
/** Makes the workspace the `bot` user's home, as current images are built: a container from an older image
 * is changed in place, so what was installed in it stays. */
export async function homeAtWorkspace(name: string): Promise<void> {
  const home = await docker(["exec", name, "sh", "-c", "getent passwd bot | cut -d: -f6"], 30_000);
  if (home !== COMPUTER_CWD) await docker(["exec", "-u", "root", name, "usermod", "-d", COMPUTER_CWD, "bot"], 30_000);
}
export async function stopContainer(name: string): Promise<void> { await docker(["stop", "--time", "5", name], 60_000); }
/** Removes the container and what was installed in it; the mounted workspace stays. */
export async function removeContainer(name: string): Promise<void> {
  try { await docker(["rm", "--force", name], 60_000); }
  catch (error) { if (!/no such (object|container)/i.test((error as Error).message)) throw error; }
}

/** Keeps the daemon in a directory of Jarvy's data that containers mount: a path that outlives upgrades, and a file
 * replaced in place, so running containers see the new one at their next start of it. */
export async function syncDaemon(dir: string): Promise<void> {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const wanted = await readFile(packagedDaemon({ platform: "linux", arch }));
  const target = join(dir, "pi-env");
  const current = await readFile(target).catch(() => null);
  if (current?.equals(wanted)) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, wanted, { mode: 0o755 });
  await rename(temp, target);
}

/** The tools' way into a running container: one daemon connection carrying every request, started on first use and
 * again after it is lost. Commands get the container's own environment variables, never this machine's. */
export function containerEnvironment(id: string, container: string, log: (text: string) => void): WorkEnvironment {
  const connection = new Connection({ command: ["docker", "exec", "-i", container, `${DAEMON_DIR}/pi-env`], onLog: text => log(text.trim()) });
  return overDurable(id, "computer", new RemoteExecutionEnv({ connection, id, cwd: COMPUTER_CWD }), { passEnv: false, close: () => connection.close() });
}

/** The bridge network a data directory's containers share (A74): they reach this machine and beyond, but not each
 * other, since inter-container traffic is off on it. Made when missing; returns its gateway, this machine's address
 * there. */
export async function ensureNetwork(name: string, labels: Record<string, string>): Promise<string> {
  const gateway = () => docker(["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}", name]).then(out => out.split(" ").find(Boolean) ?? "");
  try { return await gateway(); }
  catch (error) { if (!/not found|no such network/i.test((error as Error).message)) throw error; }
  try {
    await docker(["network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false",
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), name]);
  } catch (error) { if (!/already exists/i.test((error as Error).message)) throw error; }
  return gateway();
}
/** The networks every container with this label is on, by name, running or not. */
export async function containerNetworks(label: string): Promise<Map<string, string[]>> {
  const out = await docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}\t{{.Networks}}"]);
  return new Map(out.split("\n").filter(Boolean).map(line => { const [name, nets = ""] = line.split("\t"); return [name!, nets.split(",").filter(Boolean)]; }));
}
/** The address of each running container on a network, by name. */
export async function networkAddresses(network: string): Promise<Map<string, string>> {
  const out = await docker(["network", "inspect", "--format", "{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}", network]);
  return new Map(out.split(" ").filter(Boolean).map(entry => { const [name, address = ""] = entry.split("="); return [name!, address.split("/")[0]!]; }));
}
/** Moves a container, running or not, from Docker's default bridge to `network`; its address changes. */
export async function moveToNetwork(container: string, network: string): Promise<void> {
  await docker(["network", "connect", network, container]).catch(error => { if (!/already exists|already attached/i.test((error as Error).message)) throw error; });
  await docker(["network", "disconnect", "bridge", container]).catch(error => { if (!/not connected/i.test((error as Error).message)) throw error; });
}
/** Lets a running container made before `hosts` existed resolve a name, as `--add-host` does for new ones. Docker
 * writes /etc/hosts again when the container starts, so this is redone after each start. */
export async function addHost(container: string, name: string, address: string): Promise<void> {
  await docker(["exec", "-u", "root", container, "sh", "-c", `grep -q '[[:space:]]${name}$' /etc/hosts || printf '%s\\t%s\\n' '${address}' '${name}' >> /etc/hosts`], 30_000);
}
/** The TCP ports something listens on in a running container, each with whether every listener is on loopback only
 * (127.0.0.0/8, ::1), which nothing outside the container reaches. Read from /proc, as the image may lack `ss`. */
export async function listeningPorts(container: string): Promise<Map<number, { loopbackOnly: boolean }>> {
  const out = await docker(["exec", container, "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"], 30_000);
  const ports = new Map<number, { loopbackOnly: boolean }>();
  for (const line of out.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A") continue;
    const [address, hex] = (fields[1] ?? "").split(":");
    if (!address || !hex) continue;
    const port = parseInt(hex, 16), loopback = loopbackAddress(address);
    const known = ports.get(port);
    ports.set(port, { loopbackOnly: (known?.loopbackOnly ?? true) && loopback });
  }
  return ports;
}
/** A /proc/net address in hex: IPv4 as one little-endian word, IPv6 as four. */
function loopbackAddress(hex: string): boolean {
  if (hex.length === 8) return hex.slice(6, 8) === "7F";
  if (hex === "00000000000000000000000001000000") return true;
  return hex.startsWith("0000000000000000FFFF0000") && hex.slice(30, 32) === "7F";
}
