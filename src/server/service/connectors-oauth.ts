import type { ConnectorOAuthState } from "../../contract/connectors.js";
import type { McpDriver, McpOAuthSnapshot, StoredConnectorCredentials } from "../shared/connector.js";
import type { Store } from "../infra/storage/store.js";
import type { Listening } from "./connection.js";
import { RuntimeFault } from "../shared/runtime.js";
import { ValidationError } from "../shared/errors.js";

interface PendingFlow {
  connectorId: string;
  redirectUri: string;
  expiresAt: number;
  state: ConnectorOAuthState;
}

const FLOW_TTL_MS = 10 * 60_000;

/** Coordinates browser OAuth flows for connectors (A95): start, callback, manual paste fallback and status polling. */
export class ConnectorOAuthCoordinator {
  private readonly pending = new Map<string, PendingFlow>();
  private readonly states = new Map<string, ConnectorOAuthState>();

  constructor(
    private readonly store: Store,
    private readonly driver: McpDriver,
    private readonly listening: () => Listening | null,
    private readonly withLock: <T>(id: string, work: () => Promise<T>) => Promise<T>,
    private readonly afterAuth: (id: string) => Promise<void>,
    private readonly maskChanged: () => void,
    private readonly mask: (text: string) => string,
  ) {}

  defaultRedirectUri(): string {
    const where = this.listening();
    if (!where) return "http://127.0.0.1:12520/api/connectors/oauth/callback";
    const host = where.host === "0.0.0.0" || where.host === "::" ? "127.0.0.1" : where.host;
    const formatted = host.includes(":") ? `[${host}]` : host;
    return `${where.https ? "https" : "http"}://${formatted}:${where.port}/api/connectors/oauth/callback`;
  }

  resolveRedirectUri(raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") return this.defaultRedirectUri();
    if (typeof raw !== "string") throw new ValidationError("Invalid redirect URI", "connector_oauth_failed");
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new ValidationError("Invalid redirect URI", "connector_oauth_failed"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.pathname !== "/api/connectors/oauth/callback")
      throw new ValidationError("Invalid redirect URI", "connector_oauth_failed");
    return `${parsed.origin}${parsed.pathname}`;
  }

  status(id: string): ConnectorOAuthState {
    const current = this.states.get(id);
    return current ? { ...current } : { phase: "idle" };
  }

  clear(id: string): void {
    this.states.delete(id);
    for (const [key, flow] of this.pending) if (flow.connectorId === id) this.pending.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, flow] of this.pending) if (flow.expiresAt < now) this.pending.delete(key);
  }

  async start(id: string, redirectUri?: unknown): Promise<ConnectorOAuthState> {
    this.prune();
    const connector = this.store.connectors.get(id);
    if (!connector) throw new RuntimeFault("connector_missing", "Connector not found", 404);
    if (connector.authKind !== "oauth") throw new RuntimeFault("connector_oauth_failed", "Connector does not use OAuth", 400);
    const resolvedRedirect = this.resolveRedirectUri(redirectUri);

    return this.withLock(id, async () => {
      const creds = this.store.connectors.credentials(id);
      if (creds === null) throw new RuntimeFault("credential_unreadable", "Connector credentials cannot be decrypted", 409);
      try {
        const result = await this.driver.startOAuth({
          kind: connector.kind,
          provider: connector.provider,
          url: connector.url,
          oauth: creds.oauth,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          redirectUrl: resolvedRedirect,
        });
        this.saveOAuthSnapshot(id, creds, result.snapshot);
        if (result.outcome === "authorized") {
          await this.afterAuth(id);
          const done: ConnectorOAuthState = { phase: "completed" };
          this.states.set(id, done);
          return done;
        }
        const state: ConnectorOAuthState = { phase: "waiting", authUrl: result.authUrl, redirectUri: resolvedRedirect };
        this.states.set(id, state);
        this.pending.set(result.state, { connectorId: id, redirectUri: resolvedRedirect, expiresAt: Date.now() + FLOW_TTL_MS, state });
        return state;
      } catch (error) {
        const message = this.mask(error instanceof Error ? error.message : String(error));
        const failed: ConnectorOAuthState = { phase: "error", error: message };
        this.states.set(id, failed);
        this.store.connectors.update(id, { status: "error", statusDetail: message.slice(0, 300) });
        throw new RuntimeFault("connector_oauth_failed", message, 400);
      }
    });
  }

  async handleCallback(query: { code?: string; state?: string; iss?: string; error?: string; error_description?: string }): Promise<{ ok: boolean; name?: string; message: string }> {
    this.prune();
    if (!query.state) return { ok: false, message: "Missing OAuth state parameter." };
    const flow = this.pending.get(query.state);
    if (!flow) return { ok: false, message: "Authorization session expired or unknown. Start again from Jarvy." };
    this.pending.delete(query.state);

    const connector = this.store.connectors.get(flow.connectorId);
    if (!connector) return { ok: false, message: "Connector no longer exists." };

    if (query.error) {
      const msg = this.mask(query.error_description || query.error);
      this.states.set(connector.id, { phase: "error", error: msg });
      this.store.connectors.update(connector.id, { status: "needs_auth", statusDetail: msg.slice(0, 300) });
      return { ok: false, name: connector.name, message: msg };
    }
    if (!query.code) {
      const msg = "Missing authorization code.";
      this.states.set(connector.id, { phase: "error", error: msg });
      return { ok: false, name: connector.name, message: msg };
    }

    try {
      await this.finishCode(connector.id, connector.url, flow.redirectUri, query.code, query.iss);
      return { ok: true, name: connector.name, message: "Connected. You can close this window and return to Jarvy." };
    } catch (error) {
      const msg = this.mask(error instanceof Error ? error.message : String(error));
      return { ok: false, name: connector.name, message: msg };
    }
  }

  async completeManual(id: string, input: { callbackUrl?: unknown; code?: unknown }): Promise<ConnectorOAuthState> {
    this.prune();
    const connector = this.store.connectors.get(id);
    if (!connector) throw new RuntimeFault("connector_missing", "Connector not found", 404);

    let code = typeof input.code === "string" ? input.code.trim() : "";
    let state: string | undefined;
    let iss: string | undefined;
    if (typeof input.callbackUrl === "string" && input.callbackUrl.trim()) {
      let parsed: URL;
      try { parsed = new URL(input.callbackUrl.trim()); }
      catch { throw new ValidationError("Enter the full callback URL from your browser", "connector_oauth_failed"); }
      const err = parsed.searchParams.get("error_description") || parsed.searchParams.get("error");
      if (err) throw new RuntimeFault("connector_oauth_failed", err, 400);
      code = parsed.searchParams.get("code") ?? "";
      state = parsed.searchParams.get("state") ?? undefined;
      iss = parsed.searchParams.get("iss") ?? undefined;
    }
    if (!code) throw new ValidationError("Authorization code is required", "connector_oauth_failed");

    const flow = state ? this.pending.get(state) : [...this.pending.values()].find(entry => entry.connectorId === id);
    const currentState = this.states.get(id);
    const redirectUri = flow?.redirectUri ?? currentState?.redirectUri ?? this.defaultRedirectUri();
    if (state) this.pending.delete(state);

    await this.finishCode(id, connector.url, redirectUri, code, iss);
    return this.status(id);
  }

  private async finishCode(id: string, url: string, redirectUri: string, code: string, iss?: string): Promise<void> {
    await this.withLock(id, async () => {
      const creds = this.store.connectors.credentials(id);
      if (creds === null) throw new RuntimeFault("credential_unreadable", "Connector credentials cannot be decrypted", 409);
      try {
        const connector = this.store.connectors.get(id);
        const snapshot = await this.driver.completeOAuth({
          kind: connector?.kind,
          provider: connector?.provider,
          url,
          oauth: creds.oauth,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          redirectUrl: redirectUri,
          code,
          iss,
        });
        this.saveOAuthSnapshot(id, creds, snapshot);
        await this.afterAuth(id);
        this.states.set(id, { phase: "completed" });
      } catch (error) {
        const msg = this.mask(error instanceof Error ? error.message : String(error));
        this.states.set(id, { phase: "error", error: msg });
        this.store.connectors.update(id, { status: "error", statusDetail: msg.slice(0, 300) });
        throw new RuntimeFault("connector_oauth_failed", msg, 400);
      }
    });
  }

  private saveOAuthSnapshot(id: string, creds: StoredConnectorCredentials, snapshot: McpOAuthSnapshot): void {
    this.store.connectors.saveCredentials(id, "oauth", { ...creds, oauth: snapshot });
    this.maskChanged();
  }
}
