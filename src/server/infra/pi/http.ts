import { EventEmitter } from "node:events";
import * as undici from "undici";

/** The process-wide HTTP client the providers' fetch goes through (A40).
 * Pi's CLI sets this up itself, but the SDK does not, so Node's defaults applied: 300s for response headers and
 * between body chunks. A long-context request that took longer failed with "Request timed out." whatever the
 * provider timeout said. This mirrors Pi's own `configureHttpDispatcher` (1.2.0), which
 * the package does not export: same proxy handling, same undici for fetch and dispatcher. */
let configured = false;
export function configureHttp(timeoutMs: number): void {
  if (configured) return;
  configured = true;
  const dispatcher = new undici.EnvHttpProxyAgent({ allowH2: false, proxyTunnel: true, headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
    connect: { autoSelectFamilyAttemptTimeout: 2_000 } });
  // Undici can emit an internal "error" while ending a body mid-stream; the stream still rejects, so only keep it
  // from crashing the process.
  EventEmitter.prototype.on.call(dispatcher, "error", () => {});
  undici.setGlobalDispatcher(dispatcher);
  undici.install?.();
}
