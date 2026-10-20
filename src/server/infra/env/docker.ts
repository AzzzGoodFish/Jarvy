import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, RemoteExecutionEnv, packagedDaemon } from "@earendil-works/pi-env";
import type { WorkEnvironment } from "../../shared/environment.js";
import { COMPUTER_DOCKERFILE } from "./computer-image.js";
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
}

function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error((stderr || error.message).trim().split("\n").at(-1) ?? "docker failed"), { code: "docker_failed" }));
    else resolve(stdout.trim());
  }));
}

export async function dockerAvailable(): Promise<boolean> {
  try { await docker(["version", "--format", "{{.Server.Version}}"], 10_000); return true; }
  catch { return false; }
}

/** One image per Dockerfile and owner ids, named after both, so a change builds a new one. */
export function computerImage(uid: number, gid: number): string {
  return `jarvy-computer:${createHash("sha256").update(`${COMPUTER_DOCKERFILE}\n${uid}:${gid}`).digest("hex").slice(0, 12)}`;
}

/** Removes the other images of Bots' computers that no container uses; Docker refuses those still in use. */
export async function pruneImages(keep: string): Promise<string[]> {
  const tags = (await docker(["images", "--filter", "label=jarvy.computer=1", "--format", "{{.Repository}}:{{.Tag}}"])).split("\n").filter(Boolean);
  const removed: string[] = [];
  for (const tag of tags) if (tag !== keep) {
    try { await docker(["image", "rm", tag], 120_000); removed.push(tag); }
    catch { /* a container still uses it */ }
  }
  return removed;
}

export async function imageExists(tag: string): Promise<boolean> {
  try { await docker(["image", "inspect", "--format", "{{.Id}}", tag]); return true; }
  catch { return false; }
}

/** Builds the image from the Dockerfile alone; its output goes to `logFile`. Pulling the base takes minutes the first
 * time. */
export async function buildImage(tag: string, uid: number, gid: number, logFile: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jarvy-computer-"));
  try {
    await writeFile(join(dir, "Dockerfile"), COMPUTER_DOCKERFILE);
    const log = createWriteStream(logFile, { flags: "w", mode: 0o600 });
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("docker", ["build", "-t", tag, "--label", "jarvy.computer=1", "--build-arg", `UID=${uid}`, "--build-arg", `GID=${gid}`, dir],
        { stdio: ["ignore", "pipe", "pipe"] });
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
    "-v", `${spec.workspace}:${COMPUTER_CWD}`, "-v", `${spec.daemonDir}:${DAEMON_DIR}:ro`, "-w", COMPUTER_CWD,
    spec.image, "sleep", "infinity"], 120_000);
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
