import { randomUUID } from "node:crypto";
import type { Connector, ConnectorOAuthState, ConnectorProvider } from "../../contract/connectors.js";
import type { ConnectorDriver, McpOAuthSnapshot, StoredConnectorCredentials } from "../shared/connector.js";
import type { Store } from "../infra/storage/store.js";
import { CALLBACK_PATH, type ConnectorEnv } from "../infra/connectors/client-env.js";
import type { Listening } from "./connection.js";
import { RuntimeFault } from "../shared/runtime.js";

type PendingTarget =
  | { kind: "existing"; connectorId: string; url: string; gen: number; snapshot: McpOAuthSnapshot }
  | { kind: "preset"; flowId: string; provider: ConnectorProvider; url: string; name: string; snapshot: McpOAuthSnapshot };

interface PendingFlow {
  target: PendingTarget;
  redirectUri: string;
  expiresAt: number;
}

interface PresetFlowRecord {
  provider: ConnectorProvider;
  url: string;
  name: string;
  requestedName?: string;
  redirectUri: string;
  snapshot: McpOAuthSnapshot;
  state: ConnectorOAuthState;
  connectorId?: string;
  expiresAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;

function isLoopbackHost(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return clean === "localhost" || clean === "127.0.0.1" || clean === "::1";
}

function extractOAuthDetail(raw: unknown): string {
  const text = raw instanceof Error && raw.message ? raw.message : String(raw ?? "Authorization failed");
  const jsonStart = text.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart)) as { error_description?: unknown; error?: unknown };
      if (typeof parsed.error_description === "string" && parsed.error_description.trim()) return parsed.error_description.trim();
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch { /* fall through */ }
  }
  return text.trim() || "Authorization failed";
}

/** Coordinates browser OAuth flows for connectors (A102): supports both existing connectors and ephemeral preset flows
 * (so starting OAuth for an unconnected preset never leaves an orphan "needs auth" row if cancelled). */
export class ConnectorOAuthCoordinator {
  private readonly pending = new Map<string, PendingFlow>();
  private readonly states = new Map<string, ConnectorOAuthState>();
  private readonly presetFlows = new Map<string, PresetFlowRecord>();

  constructor(
    private readonly store: Store,
    private readonly driver: ConnectorDriver,
    private readonly listening: () => Listening | null,
    private readonly env: ConnectorEnv,
    private readonly withLock: <T>(id: string, work: () => Promise<T>) => Promise<T>,
    private readonly generation: (id: string) => number,
    private readonly createFromOAuth: (provider: ConnectorProvider, snapshot: McpOAuthSnapshot, requestedName?: string) => Promise<Connector>,
    private readonly onConnectorChanged: (id: string, reason: string) => void,
    private readonly maskChanged: () => void,
    private readonly mask: (text: string) => string,
  ) {}

  defaultRedirectUri(): string {
    const fixed = this.env.publicUrl();
    if (fixed) return `${fixed}${CALLBACK_PATH}`;
    const where = this.listening();
    if (!where) return `http://127.0.0.1:8080${CALLBACK_PATH}`;
    const host = where.host === "0.0.0.0" || where.host === "::" ? "127.0.0.1" : where.host;
    const formatted = host.includes(":") ? `[${host}]` : host;
    return `${where.https ? "https" : "http"}://${formatted}:${where.port}${CALLBACK_PATH}`;
  }

  resolveRedirectUri(raw: unknown): string {
    if (this.env.publicUrl()) return this.defaultRedirectUri();
    if (raw === undefined || raw === null || raw === "") return this.defaultRedirectUri();
    if (typeof raw !== "string") this.failOAuth("Invalid redirect URI", 400);
    let parsed: URL;
    try { parsed = new URL(raw); } catch { this.failOAuth("Invalid redirect URI", 400); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.pathname !== CALLBACK_PATH)
      this.failOAuth("Invalid redirect URI", 400);
    // OAuth 2.1 / RFC 8252 forbids plaintext HTTP redirect URIs on non-loopback hosts (e.g. Linear MCP DCR).
    // When Jarvy has TLS active on the same port, upgrade to https://; otherwise use loopback so DCR succeeds
    // and the user can paste the callback URL in the manual fallback.
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
      const where = this.listening();
      if (where?.https) return `https://${parsed.host}${parsed.pathname}`;
      const port = parsed.port || String(where?.port ?? 8080);
      return `http://127.0.0.1:${port}${parsed.pathname}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  }

  private failOAuth(raw: unknown, status = 400): never {
    const detail = this.mask(extractOAuthDetail(raw)).slice(0, 300);
    throw new RuntimeFault("connector_oauth_failed", detail, status, { detail });
  }

  status(id: string): ConnectorOAuthState {
    const current = this.states.get(id);
    return current ? { ...current } : { phase: "idle" };
  }

  presetStatus(flowId: string): { oauth: ConnectorOAuthState; connector?: Connector } {
    this.prune();
    const record = this.presetFlows.get(flowId);
    if (!record) return { oauth: { phase: "cancelled" } };
    const connector = record.connectorId ? this.store.connectors.get(record.connectorId) ?? undefined : undefined;
    return { oauth: { ...record.state }, ...(connector ? { connector } : {}) };
  }

  cancelPreset(flowId: string): void {
    this.presetFlows.delete(flowId);
    for (const [key, flow] of this.pending) {
      if (flow.target.kind === "preset" && flow.target.flowId === flowId) this.pending.delete(key);
    }
  }

  clear(id: string): void {
    this.states.delete(id);
    for (const [key, flow] of this.pending) {
      if (flow.target.kind === "existing" && flow.target.connectorId === id) this.pending.delete(key);
    }
  }

  private client(provider: ConnectorProvider, creds?: StoredConnectorCredentials): { clientId?: string; clientSecret?: string } {
    if (this.env.isManaged(provider)) return this.env.client(provider) ?? {};
    return { ...(creds?.clientId ? { clientId: creds.clientId } : {}), ...(creds?.clientSecret ? { clientSecret: creds.clientSecret } : {}) };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, flow] of this.pending) if (flow.expiresAt < now) this.pending.delete(key);
    for (const [key, record] of this.presetFlows) if (record.expiresAt < now) this.presetFlows.delete(key);
  }

  /** Starts OAuth for a curated preset without creating a database row until authorization succeeds. */
  async startPreset(provider: ConnectorProvider, redirectUri?: unknown, name?: unknown): Promise<ConnectorOAuthState> {
    this.prune();
    if (!this.driver.hasProvider(provider) || provider === "custom_mcp")
      throw new RuntimeFault("connector_missing", "Unknown connector preset", 404);
    const meta = this.driver.meta(provider);
    if (!meta.authMethods.includes("oauth"))
      this.failOAuth("Connector does not support OAuth", 400);
    if (this.env.isManaged(provider) && !this.env.client(provider)) {
      const vars = this.env.variables(provider).join(", ");
      throw new RuntimeFault("connector_client_missing", `Set ${vars} in the environment or .env and restart Jarvy`, 400);
    }
    const requestedName = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : undefined;
    const resolvedRedirect = this.resolveRedirectUri(redirectUri);
    const flowId = randomUUID();
    try {
      const started = await this.driver.startOAuth({
        provider,
        url: meta.defaultUrl,
        ...this.client(provider),
        redirectUrl: resolvedRedirect,
      });
      if (started.outcome === "authorized") {
        const created = await this.createFromOAuth(provider, started.snapshot, requestedName);
        const state: ConnectorOAuthState = { phase: "completed", flowId, connectorId: created.id };
        this.presetFlows.set(flowId, {
          provider, url: meta.defaultUrl, name: created.name, requestedName, redirectUri: resolvedRedirect,
          snapshot: started.snapshot, state, connectorId: created.id, expiresAt: Date.now() + FLOW_TTL_MS,
        });
        return state;
      }
      const state: ConnectorOAuthState = { phase: "waiting", flowId, authUrl: started.authUrl, redirectUri: resolvedRedirect };
      const expiresAt = Date.now() + FLOW_TTL_MS;
      this.presetFlows.set(flowId, {
        provider, url: meta.defaultUrl, name: requestedName ?? meta.name, requestedName, redirectUri: resolvedRedirect,
        snapshot: started.snapshot, state, expiresAt,
      });
      this.pending.set(started.state, {
        target: { kind: "preset", flowId, provider, url: meta.defaultUrl, name: requestedName ?? meta.name, snapshot: started.snapshot },
        redirectUri: resolvedRedirect,
        expiresAt,
      });
      return state;
    } catch (error) {
      this.failOAuth(error, 400);
    }
  }

  /** Starts OAuth for a Custom MCP connector (presets use immutable ephemeral flows: disconnect & add fresh to sign in again). */
  async start(id: string, redirectUri?: unknown): Promise<ConnectorOAuthState> {
    this.prune();
    const connector = this.store.connectors.get(id);
    if (!connector) throw new RuntimeFault("connector_missing", "Connector not found", 404);
    if (connector.provider !== "custom_mcp") this.failOAuth("Disconnect this connector and add it again to sign in", 400);
    if (connector.authKind !== "oauth") this.failOAuth("Connector does not use OAuth", 400);
    if (this.env.isManaged(connector.provider) && !this.env.client(connector.provider)) {
      const vars = this.env.variables(connector.provider).join(", ");
      throw new RuntimeFault("connector_client_missing", `Set ${vars} in the environment or .env and restart Jarvy`, 400);
    }
    const resolvedRedirect = this.resolveRedirectUri(redirectUri);

    return this.withLock(id, async () => {
      const startGen = this.generation(id);
      const live = this.store.connectors.get(id);
      if (!live) throw new RuntimeFault("connector_missing", "Connector not found", 404);
      const creds = this.store.connectors.credentials(id);
      if (creds === null) throw new RuntimeFault("credential_unreadable", "Connector credentials cannot be decrypted", 409);
      try {
        const started = await this.driver.startOAuth({
          provider: live.provider,
          url: live.url,
          oauth: creds.oauth,
          ...this.client(live.provider, creds),
          redirectUrl: resolvedRedirect,
        });
        if (this.generation(id) !== startGen) this.failOAuth("Connector settings changed during sign-in. Start again.", 409);
        if (started.outcome === "authorized") {
          await this.commitExistingOAuth(id, startGen, live.url, creds, started.snapshot);
          const done: ConnectorOAuthState = { phase: "completed", connectorId: id };
          this.states.set(id, done);
          return done;
        }
        const waiting: ConnectorOAuthState = { phase: "waiting", connectorId: id, authUrl: started.authUrl, redirectUri: resolvedRedirect };
        this.clear(id);
        this.states.set(id, waiting);
        this.pending.set(started.state, {
          target: { kind: "existing", connectorId: id, url: live.url, gen: startGen, snapshot: started.snapshot },
          redirectUri: resolvedRedirect,
          expiresAt: Date.now() + FLOW_TTL_MS,
        });
        return waiting;
      } catch (error) {
        if (this.generation(id) !== startGen) this.failOAuth("Connector settings changed during sign-in. Start again.", 409);
        const message = this.mask(extractOAuthDetail(error));
        this.states.set(id, { phase: "error", connectorId: id, error: message });
        this.failOAuth(message, 400);
      }
    });
  }

  async handleCallback(query: { code?: string; state?: string; iss?: string; error?: string; error_description?: string }): Promise<{ ok: boolean; name?: string; message: string }> {
    this.prune();
    if (!query.state) return { ok: false, message: "Missing OAuth state parameter." };
    const flow = this.pending.get(query.state);
    if (!flow) return { ok: false, message: "Authorization session expired or unknown. Start again from Jarvy." };
    this.pending.delete(query.state);

    if (flow.target.kind === "preset") {
      const record = this.presetFlows.get(flow.target.flowId);
      if (!record) return { ok: false, message: "Authorization session was cancelled." };
      if (query.error) {
        const msg = this.mask(query.error_description || query.error);
        record.state = { phase: "error", flowId: flow.target.flowId, error: msg };
        return { ok: false, name: record.name, message: msg };
      }
      if (!query.code) {
        const msg = "Missing authorization code.";
        record.state = { phase: "error", flowId: flow.target.flowId, error: msg };
        return { ok: false, name: record.name, message: msg };
      }
      try {
        await this.finishPresetCode(flow.target.flowId, query.code, query.iss);
        return { ok: true, name: record.name, message: "Connected. You can close this window and return to Jarvy." };
      } catch (error) {
        const msg = this.mask(error instanceof Error ? error.message : String(error));
        return { ok: false, name: record.name, message: msg };
      }
    }

    const connector = this.store.connectors.get(flow.target.connectorId);
    if (!connector) return { ok: false, message: "Connector no longer exists." };
    if (query.error) {
      const msg = this.mask(query.error_description || query.error);
      this.states.set(connector.id, { phase: "error", connectorId: connector.id, error: msg });
      this.store.connectors.update(connector.id, { status: "needs_auth", statusDetail: msg.slice(0, 300) });
      return { ok: false, name: connector.name, message: msg };
    }
    if (!query.code) {
      const msg = "Missing authorization code.";
      this.states.set(connector.id, { phase: "error", connectorId: connector.id, error: msg });
      return { ok: false, name: connector.name, message: msg };
    }
    try {
      await this.finishExistingCode(connector.id, flow.target.url, flow.target.gen, flow.redirectUri, flow.target.snapshot, query.code, query.iss);
      return { ok: true, name: connector.name, message: "Connected. You can close this window and return to Jarvy." };
    } catch (error) {
      const msg = this.mask(error instanceof Error ? error.message : String(error));
      return { ok: false, name: connector.name, message: msg };
    }
  }

  private parseManualInput(input: { callbackUrl?: unknown; code?: unknown }): { hasCallbackUrl: boolean; code: string; state?: string; iss?: string } {
    const rawUrl = typeof input.callbackUrl === "string" ? input.callbackUrl.trim() : "";
    if (rawUrl) {
      let parsed: URL;
      try { parsed = new URL(rawUrl); }
      catch { this.failOAuth("Enter the full callback URL from your browser", 400); }
      const err = parsed.searchParams.get("error_description") || parsed.searchParams.get("error");
      if (err) this.failOAuth(err, 400);
      const code = parsed.searchParams.get("code")?.trim() ?? "";
      const state = parsed.searchParams.get("state")?.trim() ?? "";
      const iss = parsed.searchParams.get("iss")?.trim() || undefined;
      if (!code) this.failOAuth("Authorization code is required", 400);
      if (!state) this.failOAuth("Callback URL is missing its OAuth state parameter", 400);
      return { hasCallbackUrl: true, code, state, iss };
    }
    const code = typeof input.code === "string" ? input.code.trim() : "";
    if (!code) this.failOAuth("Authorization code is required", 400);
    return { hasCallbackUrl: false, code };
  }

  private consumePending(
    parsed: { hasCallbackUrl: boolean; state?: string },
    matchesTarget: (target: PendingTarget) => boolean,
  ): PendingFlow {
    const now = Date.now();
    if (parsed.hasCallbackUrl) {
      const state = parsed.state!;
      const flow = this.pending.get(state);
      // Validate ownership and freshness BEFORE consuming so a mismatched/expired callback never disturbs another flow.
      if (!flow || flow.expiresAt < now || !matchesTarget(flow.target)) {
        this.failOAuth("Callback does not match an active authorization session for this connector", 400);
      }
      this.pending.delete(state);
      return flow;
    }
    const live = [...this.pending.entries()].filter(([, flow]) => flow.expiresAt >= now && matchesTarget(flow.target));
    if (live.length !== 1) {
      this.failOAuth("No active authorization session for this connector. Start sign-in again.", 409);
    }
    const [state, flow] = live[0]!;
    this.pending.delete(state);
    return flow;
  }

  async completePresetManual(flowId: string, input: { callbackUrl?: unknown; code?: unknown }): Promise<{ oauth: ConnectorOAuthState; connector?: Connector }> {
    this.prune();
    const record = this.presetFlows.get(flowId);
    if (!record || record.state.phase !== "waiting" || record.expiresAt < Date.now()) {
      this.failOAuth("Authorization session expired. Start again.", 409);
    }
    const parsed = this.parseManualInput(input);
    this.consumePending(parsed, target => target.kind === "preset" && target.flowId === flowId);
    await this.finishPresetCode(flowId, parsed.code, parsed.iss);
    return this.presetStatus(flowId);
  }

  async completeManual(id: string, input: { callbackUrl?: unknown; code?: unknown }): Promise<ConnectorOAuthState> {
    this.prune();
    const connector = this.store.connectors.get(id);
    if (!connector) throw new RuntimeFault("connector_missing", "Connector not found", 404);
    const parsed = this.parseManualInput(input);
    const flow = this.consumePending(parsed, target => target.kind === "existing" && target.connectorId === id);
    const expectedUrl = flow.target.kind === "existing" ? flow.target.url : connector.url;
    const expectedGen = flow.target.kind === "existing" ? flow.target.gen : this.generation(id);
    const pendingSnapshot = flow.target.kind === "existing" ? flow.target.snapshot : undefined;
    await this.finishExistingCode(id, expectedUrl, expectedGen, flow.redirectUri, pendingSnapshot, parsed.code, parsed.iss);
    return this.status(id);
  }

  private async finishPresetCode(flowId: string, code: string, iss?: string): Promise<void> {
    const record = this.presetFlows.get(flowId);
    if (!record) this.failOAuth("Authorization session expired", 409);
    try {
      const snapshot = await this.driver.completeOAuth({
        provider: record.provider,
        url: record.url,
        oauth: record.snapshot,
        ...this.client(record.provider),
        redirectUrl: record.redirectUri,
        code,
        iss,
      });
      const created = await this.createFromOAuth(record.provider, snapshot, record.requestedName);
      record.name = created.name;
      record.connectorId = created.id;
      record.state = { phase: "completed", flowId, connectorId: created.id };
    } catch (error) {
      const msg = this.mask(extractOAuthDetail(error));
      record.state = { phase: "error", flowId, error: msg };
      this.failOAuth(msg, 400);
    }
  }

  private async finishExistingCode(
    id: string, expectedUrl: string, expectedGen: number, redirectUri: string,
    pendingSnapshot: McpOAuthSnapshot | undefined, code: string, iss?: string,
  ): Promise<void> {
    await this.withLock(id, async () => {
      if (this.generation(id) !== expectedGen) this.failOAuth("Connector settings changed during authorization. Start again.", 409);
      const connector = this.store.connectors.get(id);
      if (!connector) throw new RuntimeFault("connector_missing", "Connector not found", 404);
      if (connector.url !== expectedUrl) this.failOAuth("Connector destination changed during authorization. Start again.", 409);
      const creds = this.store.connectors.credentials(id);
      if (creds === null) throw new RuntimeFault("credential_unreadable", "Connector credentials cannot be decrypted", 409);
      try {
        const snapshot = await this.driver.completeOAuth({
          provider: connector.provider,
          url: connector.url,
          oauth: pendingSnapshot ?? creds.oauth,
          ...this.client(connector.provider, creds),
          redirectUrl: redirectUri,
          code,
          iss,
        });
        // Discard stale OAuth exchange if settings/disconnect/delete mutated this connector while awaiting the token endpoint.
        if (this.generation(id) !== expectedGen || this.store.connectors.get(id)?.url !== expectedUrl) {
          this.failOAuth("Connector settings changed during authorization. Start again.", 409);
        }
        await this.commitExistingOAuth(id, expectedGen, expectedUrl, creds, snapshot);
        this.states.set(id, { phase: "completed", connectorId: id });
      } catch (error) {
        if (this.generation(id) !== expectedGen) this.failOAuth("Connector settings changed during authorization. Start again.", 409);
        const msg = this.mask(extractOAuthDetail(error));
        this.states.set(id, { phase: "error", connectorId: id, error: msg });
        this.failOAuth(msg, 400);
      }
    });
  }

  /** Probes a newly exchanged OAuth snapshot for Custom MCP BEFORE saving; clears any prior Bot grants & pending cards so permissions never transfer across accounts. */
  private async commitExistingOAuth(
    id: string, expectedGen: number, expectedUrl: string, creds: StoredConnectorCredentials, snapshot: McpOAuthSnapshot,
  ): Promise<void> {
    const live = this.store.connectors.get(id);
    if (!live) throw new RuntimeFault("connector_missing", "Connector not found", 404);
    const probed = await this.driver.probe({
      provider: live.provider, url: live.url, authKind: "oauth", oauth: snapshot,
      ...this.client(live.provider, creds), redirectUrl: this.defaultRedirectUri(),
    });
    if (this.generation(id) !== expectedGen || this.store.connectors.get(id)?.url !== expectedUrl) {
      this.failOAuth("Connector settings changed during authorization. Start again.", 409);
    }
    if (probed.outcome !== "connected") this.failOAuth(probed.message, 400);
    const finalOAuth = "snapshot" in probed && probed.snapshot ? probed.snapshot : snapshot;
    const label = probed.accountLabel?.trim().slice(0, 120) ?? "";
    this.store.connectors.revokeAll(id);
    this.onConnectorChanged(id, "Connector credentials changed.");
    this.store.connectors.saveCredentials(id, "oauth", { ...creds, oauth: finalOAuth });
    this.maskChanged();
    this.store.connectors.update(id, {
      status: "connected", statusDetail: label, accountLabel: label || null, tools: probed.tools,
    });
  }
}
