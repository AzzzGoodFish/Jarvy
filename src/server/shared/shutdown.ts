/** Bounded shutdown utilities shared across infra, service, and CLI layers (A114). */

export interface ShutdownStepOutcome {
  name: string;
  status: "ok" | "timeout" | "error";
  durationMs: number;
  error?: string;
}

/** Combines a default timeout with an optional caller AbortSignal so I/O cannot hang indefinitely. */
export function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Runs an async cleanup step with a hard time budget, capturing timeouts and errors instead of
 * throwing so one stalled subsystem can never block later shutdown phases (A114). */
export async function runBounded(
  name: string,
  timeoutMs: number,
  work: () => void | Promise<unknown>,
  log?: (message: string) => void,
): Promise<ShutdownStepOutcome> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const task = Promise.resolve().then(work);
    // Attach a noop rejection handler so a late rejection after timeout never crashes the process.
    task.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, Math.max(1, timeoutMs));
      timer.unref();
    });
    await Promise.race([task, timeout]);
    return { name, status: "ok", durationMs: Date.now() - started };
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const status = timedOut ? "timeout" : "error";
    log?.(`[shutdown] step=${name} ${status} after ${durationMs}ms: ${message}`);
    return { name, status, durationMs, error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
