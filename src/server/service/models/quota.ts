import type { ConnectionQuota, ModelConnection, QuotaWindow } from "../../../contract/models.js";
import type { Store } from "../../infra/storage/store.js";
import type { CredentialCoordinator } from "../../infra/credentials/coordinator.js";
import { ConnectionCredentials } from "../../infra/pi/credentials.js";
import { createRuntime } from "../../infra/pi/providers.js";
import { checkOnRequest, quotaCheck, quotaFromReply, quotaPage, QuotaHttpError, type QuotaReading } from "../../infra/pi/quota/index.js";
import { RuntimeFault } from "../../shared/runtime.js";

/** A check this recent is shown again instead of asking the provider. */
const FRESH_MS = 5 * 60_000;
/** After a failed check the page doesn't ask again for a minute; after the provider said too many, for ten. */
const RETRY_MS = 60_000, LIMITED_MS = 10 * 60_000;

interface Kept { reading?: QuotaReading; at?: number; source?: "check" | "response"; error?: string; holdUntil?: number; pending?: Promise<void> }

/** Subscription connections' usage limits (A94), read from their providers with the connection's own sign-in. Kept
 * in memory only: nothing is stored, and a restart starts over. Checks of one connection are never run twice at once,
 * and a failed one keeps the last result. */
export class ConnectionQuotas {
  private readonly kept = new Map<string, Kept>();
  constructor(private readonly store: Store, private readonly credentials: CredentialCoordinator) {}

  /** The connection's limits: checked again when older than five minutes, or now with `refresh`. A provider whose
   * check is limited hard (Anthropic) is checked only with `refresh`; its replies keep it current meanwhile. */
  async get(id: string, refresh = false): Promise<ConnectionQuota> {
    const connection = this.store.connections.get(id);
    if (!connection) throw new RuntimeFault("connection_missing", "Connection not found", 404);
    const entry = this.entry(id), check = quotaCheck(connection.providerName);
    if (connection.authType !== "oauth" || !connection.configured) return { state: "none", windows: [] };
    if (!check) return entry.reading ? this.view(entry) : { state: "none", windows: [], ...(quotaPage(connection.providerName) ? { link: quotaPage(connection.providerName) } : {}) };
    const now = Date.now();
    const due = refresh || (!checkOnRequest(connection.providerName) && !(entry.at && now - entry.at < FRESH_MS) && !(entry.holdUntil && now < entry.holdUntil));
    if (due || entry.pending) await this.run(connection, entry);
    if (!entry.reading && !entry.error) return { state: "unchecked", windows: [] };
    return this.view(entry);
  }

  /** A model reply's headers for a connection: the limits some providers send with every reply (A94). */
  observe(id: string, provider: string, headers: Record<string, string>): void {
    const reading = quotaFromReply(provider, headers);
    if (!reading) return;
    const entry = this.entry(id), before = entry.reading;
    // A reply carries the main windows only: the plan and the named limits of the last check stay.
    const named = (before?.windows ?? []).filter(window => window.name && !reading.windows.some(same(window)));
    entry.reading = { windows: [...reading.windows, ...named], ...(before?.plan ? { plan: before.plan } : {}) };
    Object.assign(entry, { at: Date.now(), source: "response", error: undefined, holdUntil: undefined });
  }
  /** The sign-in changed or went: what was read belongs to the old one. */
  forget(id: string): void { this.kept.delete(id); }

  private entry(id: string): Kept {
    let entry = this.kept.get(id);
    if (!entry) this.kept.set(id, entry = {});
    return entry;
  }
  private run(connection: ModelConnection, entry: Kept): Promise<void> {
    entry.pending ??= (async () => {
      try {
        const reading = await this.read(connection);
        Object.assign(entry, { reading, at: Date.now(), source: "check", error: undefined, holdUntil: undefined });
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        entry.holdUntil = Date.now() + (error instanceof QuotaHttpError && error.status === 429 ? LIMITED_MS : RETRY_MS);
        console.warn("[models] usage check failed", { provider: connection.providerName, error: entry.error });
      } finally { entry.pending = undefined; }
    })();
    return entry.pending;
  }
  /** Reads with the connection's credential, refreshed first when it is about to expire (and saved, as a Bot's
   * request would save it). No caller's cancelling stops it: others may be waiting for the same check. */
  private async read(connection: ModelConnection): Promise<QuotaReading> {
    const check = quotaCheck(connection.providerName)!;
    const scoped = new ConnectionCredentials(this.store.credentials, this.credentials, this.store.account.userMemberId(), connection.id, connection.providerName);
    const runtime = await createRuntime({ credentials: scoped, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    await runtime.getAuth(connection.providerName);
    const credential = await scoped.read(connection.providerName);
    if (credential?.type !== "oauth") throw new RuntimeFault("credentials_missing", "Sign in first.", 422);
    return check(credential as typeof credential & Record<string, unknown>, new AbortController().signal);
  }
  private view(entry: Kept): ConnectionQuota {
    return { state: entry.reading ? "ok" : "failed", windows: entry.reading?.windows ?? [], ...(entry.reading?.plan ? { plan: entry.reading.plan } : {}),
      ...(entry.at ? { checkedAt: entry.at, source: entry.source } : {}), ...(entry.error ? { error: entry.error } : {}) };
  }
}
const same = (window: QuotaWindow) => (other: QuotaWindow) => other.kind === window.kind && other.hours === window.hours && other.name === window.name;
