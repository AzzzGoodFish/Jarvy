import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Background lifecycle for `jarvy on` / `jarvy off`.
// The server process owns `<dataDir>/jarvy.pid`; the data-root lock still guarantees exclusivity,
// the pid file only lets `off` find the process without taking that lock.
interface PidRecord { pid: number; startToken: string; url: string; startedAt: number; }
const pidPath = (dir: string) => join(resolve(dir), "jarvy.pid");
export const logPath = (dir: string) => join(resolve(dir), "jarvy.log");

export function writePidFile(dir: string, url: string): void {
  const record: PidRecord = { pid: process.pid, startToken: startToken(process.pid), url, startedAt: Date.now() };
  writeFileSync(pidPath(dir), JSON.stringify(record), { mode: 0o600 });
}
/** Only removes the file if it still names this process (a later `on` may have replaced it). */
export function removePidFile(dir: string): void {
  if (readRecord(dir)?.pid === process.pid) rmSync(pidPath(dir), { force: true });
}
function readRecord(dir: string): PidRecord | null {
  try { return JSON.parse(readFileSync(pidPath(dir), "utf8")) as PidRecord; } catch { return null; }
}
/** Linux process start time (/proc/<pid>/stat field 22); "" where unavailable. */
function startToken(pid: number): string {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19] ?? ""; } catch { return ""; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
/** Running server for this data dir, or null. A leftover file from a crash is removed. */
export function runningServer(dir: string): PidRecord | null {
  const record = readRecord(dir);
  if (!record) return null;
  // After a crash the PID may be reused by an unrelated process; where Linux exposes the start
  // time, require it to match before signalling. Other platforms rely on the liveness check.
  const token = alive(record.pid) ? startToken(record.pid) : null;
  if (token === null || (token && record.startToken && token !== record.startToken)) { rmSync(pidPath(dir), { force: true }); return null; }
  return record;
}

/** Starts `run` detached with output in jarvy.log; resolves once it listens, rejects if it exits. */
export function startBackground(script: string, runArgs: string[], dir: string): Promise<{ pid: number; url: string }> {
  mkdirSync(resolve(dir), { recursive: true, mode: 0o700 });
  const log = openSync(logPath(dir), "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, script, "run", ...runArgs], { detached: true, stdio: ["ignore", log, log, "ipc"] });
  closeSync(log);
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`${lastLogLine(dir) ?? `exited during startup (code ${code ?? "signal"})`}; see ${logPath(dir)}`)));
    child.once("message", message => {
      const ready = message as { type?: string; url?: string };
      if (ready.type !== "ready") return;
      child.removeAllListeners("exit"); child.disconnect(); child.unref();
      resolvePromise({ pid: child.pid!, url: ready.url ?? "" });
    });
  });
}
/** The child's own error line (it prints "Jarvy: <reason>" before exiting). */
function lastLogLine(dir: string): string | null {
  try { return readFileSync(logPath(dir), "utf8").slice(-4000).trim().split("\n").reverse().find(line => line.startsWith("Jarvy: "))?.slice(7) ?? null; }
  catch { return null; }
}
/** Tells the parent `on` process that the server is listening (no-op in foreground `run`). */
export function signalReady(url: string): void {
  if (!process.send) return;
  process.send({ type: "ready", url });
  process.disconnect();
}

/** SIGTERM → the server's normal shutdown path; waits for the process to exit. */
export async function stopServer(dir: string, waitMs = 30_000): Promise<"stopped" | "not_running" | "still_running"> {
  const record = runningServer(dir);
  if (!record) return "not_running";
  process.kill(record.pid, "SIGTERM");
  for (const deadline = Date.now() + waitMs; Date.now() < deadline;) {
    if (!alive(record.pid)) { rmSync(pidPath(dir), { force: true }); return "stopped"; }
    await new Promise(done => setTimeout(done, 200));
  }
  return "still_running";
}
