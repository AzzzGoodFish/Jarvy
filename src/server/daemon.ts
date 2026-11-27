import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Generic background daemon lifecycle shared by `jarvy server start|stop|status` and `jarvy client start|stop|status` (A27, A106).
 * Tracks PID + Linux process start time (`/proc/<pid>/stat` field 22) to prevent signalling a reused PID after a crash. */
export interface PidRecord {
  pid: number;
  startToken: string;
  url: string;
  name?: string;
  startedAt: number;
}

export interface DaemonFiles {
  dir: string;
  pidFile: string;
  logFile: string;
  label: string;
}

export const daemonPidPath = (dir: string, pidFile: string) => join(resolve(dir), pidFile);
export const daemonLogPath = (dir: string, logFile: string) => join(resolve(dir), logFile);

export function writePidFile(dir: string, pidFile: string, meta: { url: string; name?: string }): void {
  mkdirSync(resolve(dir), { recursive: true, mode: 0o700 });
  const record: PidRecord = {
    pid: process.pid,
    startToken: startToken(process.pid),
    url: meta.url,
    ...(meta.name ? { name: meta.name } : {}),
    startedAt: Date.now(),
  };
  writeFileSync(daemonPidPath(dir, pidFile), JSON.stringify(record), { mode: 0o600 });
}

/** Only removes the file if it still names this process (a later `start` may have replaced it). */
export function removePidFile(dir: string, pidFile: string): void {
  if (readRecord(dir, pidFile)?.pid === process.pid) rmSync(daemonPidPath(dir, pidFile), { force: true });
}

function readRecord(dir: string, pidFile: string): PidRecord | null {
  try { return JSON.parse(readFileSync(daemonPidPath(dir, pidFile), "utf8")) as PidRecord; } catch { return null; }
}

/** Linux process start time (/proc/<pid>/stat field 22); "" where unavailable. */
function startToken(pid: number): string {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19] ?? ""; } catch { return ""; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  // On Linux, an exited zombie (`Z`) or dead (`X`) process still answers `kill(pid, 0)` until reaped by PID 1
  // (common inside containers without `--init`); treat it as stopped.
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()?.split(" ")[0];
    if (state === "Z" || state === "X") return false;
  } catch { /* non-Linux or already reaped */ }
  return true;
}

/** Running daemon record for this directory, or null. A leftover PID file from a crash is cleaned up. */
export function runningDaemon(dir: string, pidFile: string): PidRecord | null {
  const record = readRecord(dir, pidFile);
  if (!record) return null;
  const token = alive(record.pid) ? startToken(record.pid) : null;
  if (token === null || (token && record.startToken && token !== record.startToken)) {
    rmSync(daemonPidPath(dir, pidFile), { force: true });
    return null;
  }
  return record;
}

/** Starts a foreground subcommand detached with stdout/stderr appended to `logFile`; resolves once IPC signals ready. */
export function startDaemon(
  script: string,
  childArgs: string[],
  files: DaemonFiles,
): Promise<{ pid: number; url: string; name?: string }> {
  mkdirSync(resolve(files.dir), { recursive: true, mode: 0o700 });
  const log = openSync(daemonLogPath(files.dir, files.logFile), "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, script, ...childArgs], {
    detached: true,
    stdio: ["ignore", log, log, "ipc"],
  });
  closeSync(log);
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(
      `${lastLogLine(files.dir, files.logFile) ?? `${files.label} exited during startup (code ${code ?? "signal"})`}; see ${daemonLogPath(files.dir, files.logFile)}`,
    )));
    child.once("message", message => {
      const ready = message as { type?: string; url?: string; name?: string };
      if (ready.type !== "ready") return;
      child.removeAllListeners("exit");
      child.disconnect();
      child.unref();
      resolvePromise({ pid: child.pid!, url: ready.url ?? "", ...(ready.name ? { name: ready.name } : {}) });
    });
  });
}

function lastLogLine(dir: string, logFile: string): string | null {
  try {
    return readFileSync(daemonLogPath(dir, logFile), "utf8")
      .slice(-4000).trim().split("\n").reverse()
      .find(line => line.startsWith("Jarvy: "))?.slice(7) ?? null;
  } catch {
    return null;
  }
}

/** Tells the parent `start` process that the child is ready (no-op when run directly in foreground). */
export function signalDaemonReady(meta: { url: string; name?: string }): void {
  if (!process.send) return;
  process.send({ type: "ready", url: meta.url, ...(meta.name ? { name: meta.name } : {}) });
  process.disconnect();
}

/** SIGTERM → graceful shutdown path; waits up to `waitMs` for process exit without SIGKILL. */
export async function stopDaemon(dir: string, pidFile: string, waitMs = 30_000): Promise<"stopped" | "not_running" | "still_running"> {
  const record = runningDaemon(dir, pidFile);
  if (!record) return "not_running";
  process.kill(record.pid, "SIGTERM");
  for (const deadline = Date.now() + waitMs; Date.now() < deadline;) {
    if (!alive(record.pid)) {
      rmSync(daemonPidPath(dir, pidFile), { force: true });
      return "stopped";
    }
    await new Promise(done => setTimeout(done, 200));
  }
  return "still_running";
}
