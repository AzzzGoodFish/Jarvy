import type { ShutdownStepOutcome } from "./shared/shutdown.js";

/** Ref'd sleep used while shutdown is active so closing the listener cannot exit the event loop before storage flush. */
function sleepRef(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/** Phased, time-budgeted server shutdown and restart coordinator (A114).
 *
 * Guarantees that:
 * 1. In-flight HTTP responses (e.g. `202 Accepted` from `/api/system/update/apply`) and WS `1001` close frames
 *    flush cleanly before sockets are destroyed.
 * 2. A hung Bot, remote environment, or MCP call never prevents final cloud sync, cloud lease release, SQLite
 *    close, or `.runtime.lock` release.
 * 3. A hard process watchdog (< systemd `TimeoutStopSec=30s`) and double-signal escalation ensure the server
 *    can never become stranded with its listening port closed while the process refuses to exit. */

export type ShutdownReason = "signal" | "update" | "fencing";
export type ShutdownPhase = "idle" | "drain" | "services" | "network" | "storage" | "finish";

export interface ShutdownBudgets {
  /** Grace window after `stopAccepting()` so in-flight HTTP responses finish flushing. */
  drainGraceMs?: number;
  /** Time budget for draining Bots, remote environments, and devices. */
  serviceTimeoutMs?: number;
  /** Short grace after WS `1001` frames are queued so peers observe a clean close before socket destroy. */
  wsCloseGraceMs?: number;
  /** Time budget for final cloud snapshot flush before releasing the fencing lease. */
  syncTimeoutMs?: number;
  /** Time budget for releasing the cloud fencing lease. */
  releaseTimeoutMs?: number;
  /** Hard end-to-end ceiling; must stay strictly below systemd `TimeoutStopSec=30s`. */
  watchdogMs?: number;
}

export interface ServerShutdownDeps {
  setDraining(draining: boolean): void;
  stopAccepting(): void;
  closeServices(options: { serviceTimeoutMs: number; log: (msg: string) => void }): Promise<ShutdownStepOutcome[]>;
  closeNetwork(): void;
  closeStorage(options: { syncTimeoutMs: number; releaseTimeoutMs: number; log: (msg: string) => void }): Promise<ShutdownStepOutcome[]>;
  removePidFile(): void;
  respawn(): void;
  exit?(code: number): void;
  log?(message: string): void;
  budgets?: ShutdownBudgets;
}

export interface ServerShutdownController {
  readonly active: boolean;
  readonly phase: ShutdownPhase;
  trigger(reason: ShutdownReason): Promise<void>;
  handleSignal(signal: "SIGINT" | "SIGTERM"): void;
}

const DEFAULT_BUDGETS: Required<ShutdownBudgets> = {
  drainGraceMs: 300,
  serviceTimeoutMs: 8_000,
  wsCloseGraceMs: 100,
  syncTimeoutMs: 5_000,
  releaseTimeoutMs: 3_000,
  watchdogMs: 20_000,
};

export function createServerShutdown(deps: ServerShutdownDeps): ServerShutdownController {
  const budgets: Required<ShutdownBudgets> = { ...DEFAULT_BUDGETS, ...deps.budgets };
  const log = deps.log ?? (msg => console.log(msg));
  const exit = deps.exit ?? (code => process.exit(code));

  let active = false;
  let phase: ShutdownPhase = "idle";
  let restartRequested = false;
  let exited = false;
  let runPromise: Promise<void> | null = null;
  let watchdog: NodeJS.Timeout | null = null;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    exit(code);
  };

  const trigger = (reason: ShutdownReason): Promise<void> => {
    if (reason === "update") restartRequested = true;
    if (runPromise) return runPromise;
    active = true;

    const totalStart = Date.now();
    log(`[shutdown] starting (reason=${reason}, watchdog=${budgets.watchdogMs}ms)`);

    // Keep watchdog ref'd while shutdown is active so closing the TCP listener never lets Node exit before storage flush.
    watchdog = setTimeout(() => {
      log(`[shutdown] hard timeout after ${budgets.watchdogMs}ms during phase=${phase}; forcing exit`);
      try { deps.closeNetwork(); } catch { /* best-effort */ }
      try { deps.removePidFile(); } catch { /* best-effort */ }
      if (restartRequested) {
        try { deps.respawn(); } catch { /* best-effort */ }
      }
      exitOnce(1);
    }, budgets.watchdogMs);

    runPromise = (async () => {
      const timings: string[] = [];
      const mark = (name: string, start: number) => timings.push(`${name}=${Date.now() - start}ms`);

      try {
        // Phase 1: Drain — reject new requests with 503 and stop accepting TCP connections while letting in-flight replies flush.
        phase = "drain";
        let t = Date.now();
        deps.setDraining(true);
        deps.stopAccepting();
        await sleepRef(budgets.drainGraceMs);
        mark("drain", t);

        // Phase 2: Services — bounded, isolated teardown; sends WS 1001 "Jarvy is stopping" while sockets remain open.
        phase = "services";
        t = Date.now();
        await deps.closeServices({ serviceTimeoutMs: budgets.serviceTimeoutMs, log });
        await sleepRef(budgets.wsCloseGraceMs);
        mark("services", t);

        // Phase 3: Network — tear down any lingering TCP sockets so listening ports are guaranteed free.
        phase = "network";
        t = Date.now();
        deps.closeNetwork();
        mark("network", t);

        // Phase 4: Storage — mandatory final cloud sync, lease release, SQLite close, runtime lock & PID cleanup.
        phase = "storage";
        t = Date.now();
        await deps.closeStorage({ syncTimeoutMs: budgets.syncTimeoutMs, releaseTimeoutMs: budgets.releaseTimeoutMs, log });
        deps.removePidFile();
        mark("storage", t);

        // Phase 5: Finish — respawn only after port, local lock, and cloud lease are all released.
        phase = "finish";
        const elapsed = Date.now() - totalStart;
        log(`[shutdown] complete in ${elapsed}ms (reason=${reason}, ${timings.join(", ")})`);
        if (restartRequested) {
          log("Jarvy server stopped for update; restarting...");
          deps.respawn();
        } else {
          log("Jarvy server stopped.");
        }
        const exitCode = reason === "fencing" ? 1 : (typeof process.exitCode === "number" ? process.exitCode : 0);
        exitOnce(exitCode);
      } catch (error) {
        log(`[shutdown] failed during phase=${phase}: ${error instanceof Error ? error.message : String(error)}`);
        try { deps.closeNetwork(); } catch { /* best-effort */ }
        try { deps.removePidFile(); } catch { /* best-effort */ }
        if (restartRequested) {
          try { deps.respawn(); } catch { /* best-effort */ }
        }
        exitOnce(1);
      }
    })();

    return runPromise;
  };

  const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (!active) {
      void trigger("signal");
      return;
    }
    log(`[shutdown] received second ${signal} during phase=${phase}; forcing immediate exit`);
    try { deps.closeNetwork(); } catch { /* best-effort */ }
    try { deps.removePidFile(); } catch { /* best-effort */ }
    exitOnce(signal === "SIGINT" ? 130 : 143);
  };

  return {
    get active() { return active; },
    get phase() { return phase; },
    trigger,
    handleSignal,
  };
}
