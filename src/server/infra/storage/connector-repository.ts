import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Connector, ConnectorAuthKind, ConnectorGrant, ConnectorKind, ConnectorProvider,
  ConnectorStatus, ConnectorTool, ConnectorUse,
} from "../../../contract/connectors.js";
import type { GrantScope } from "../../../contract/secrets.js";
import {
  isWriteTool, toolDefinitionHash,
  type ConnectorRuntimeInfo, type StoredConnectorCredentials,
} from "../../shared/connector.js";
import type { Cipher } from "../vault/cipher.js";
import { transaction } from "./transaction.js";

interface ConnectorRow {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  kind: ConnectorKind;
  provider: ConnectorProvider;
  config_json: string;
  enabled: number;
  status: ConnectorStatus;
  status_detail: string;
  tools_json: string;
  created_at: number;
  updated_at: number;
}

interface StoredConfig {
  url?: string;
  authKind?: ConnectorAuthKind;
  accountLabel?: string;
}

function hashCredentials(authType: string, creds: StoredConnectorCredentials): string {
  const headerEntries = Object.entries(creds.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const tokenKey = creds.oauth?.tokens?.refresh_token || creds.oauth?.tokens?.access_token || "";
  return createHash("sha256").update(JSON.stringify({
    authType,
    headers: headerEntries,
    clientId: creds.clientId ?? "",
    oauthClientId: creds.oauth?.clientInformation?.client_id ?? "",
    tokenKey,
  })).digest("hex");
}

/** Persistent connectors, sealed credentials, fingerprinted write-tool approvals, per-Bot grants and usage logs (A102). */
export class ConnectorRepository {
  private runtime: ConnectorRuntimeInfo | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: Cipher,
    private readonly ownerId: () => string,
  ) {}

  /** Supplies provider runtime metadata (managed OAuth client status, auth methods, deployment secrets). */
  useRuntime(runtime: ConnectorRuntimeInfo): void { this.runtime = runtime; }

  private parseJson<T>(raw: string, fallback: T): T {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }

  private toView(row: ConnectorRow): Connector {
    const config = this.parseJson<StoredConfig>(row.config_json, {});
    const rawTools = this.parseJson<ConnectorTool[]>(row.tools_json, []);
    const tools: ConnectorTool[] = Array.isArray(rawTools)
      ? rawTools.map(tool => ({ ...tool, write: isWriteTool(tool) }))
      : [];
    const credRow = this.db.prepare("SELECT auth_type AS authType, credential_json AS json FROM connector_credentials WHERE connector_id=?")
      .get(row.id) as { authType: string; json: string } | undefined;
    let readable = true;
    let headerNames: string[] = [];
    let oauthClientId: string | null = null;
    let hasClientSecret = false;
    let credFp = "none";
    if (credRow) {
      const plain = this.cipher.open(credRow.json, `connector:${row.id}`);
      if (plain === null) {
        readable = false;
        credFp = "unreadable";
      } else {
        const creds = this.parseJson<StoredConnectorCredentials>(plain, {});
        headerNames = Object.keys(creds.headers ?? {}).sort();
        oauthClientId = creds.clientId ?? null;
        hasClientSecret = Boolean(creds.clientSecret);
        credFp = hashCredentials(credRow.authType, creds).slice(0, 16);
      }
    }
    const grants = (this.db.prepare(`SELECT bot_id AS botId, scope, granted_at AS grantedAt FROM connector_grants g
      WHERE connector_id=? AND (scope='always' OR EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=g.run_id AND r.ended_at IS NULL))
      ORDER BY granted_at ASC`).all(row.id) as unknown as ConnectorGrant[]).map(grant => ({ ...grant }));
    const stats = this.db.prepare("SELECT COUNT(*) AS count, MAX(at) AS lastAt FROM connector_uses WHERE connector_id=?")
      .get(row.id) as { count: number; lastAt: number | null };
    const managedClient = this.runtime?.managedClient(row.provider) ?? null;
    const authMethods = this.runtime?.authMethods(row.provider) ?? ["oauth", "headers", "none"];
    const unconfirmed = this.activeUnconfirmed(row.id, tools);
    const account = config.accountLabel || (row.status === "connected" ? row.status_detail : "");
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      provider: row.provider,
      url: config.url ?? "",
      authKind: config.authKind ?? "oauth",
      authMethods,
      headerNames,
      oauthClientId: managedClient ? null : oauthClientId,
      hasClientSecret: managedClient ? false : hasClientSecret,
      managedClient,
      unconfirmed,
      enabled: row.enabled === 1,
      status: row.status,
      statusDetail: row.status_detail,
      account,
      credFp,
      readable,
      tools,
      grants,
      uses: stats?.count ?? 0,
      lastUsedAt: stats?.lastAt ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Only approvals whose stored definition hash still matches the current tool definition remain active (A102). */
  private activeUnconfirmed(id: string, tools: ConnectorTool[]): string[] {
    const rows = this.db.prepare("SELECT tool_name AS name, definition_hash AS hash FROM connector_unconfirmed_tools WHERE connector_id=? ORDER BY tool_name")
      .all(id) as { name: string; hash: string }[];
    if (!rows.length) return [];
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    const active: string[] = [];
    for (const row of rows) {
      const tool = byName.get(row.name);
      if (!tool || !isWriteTool(tool)) continue;
      if (row.hash && row.hash === toolDefinitionHash(tool)) active.push(row.name);
    }
    return active;
  }

  list(): Connector[] {
    this.purge();
    const rows = this.db.prepare("SELECT * FROM connectors WHERE owner_id=? ORDER BY created_at ASC").all(this.ownerId()) as unknown as ConnectorRow[];
    return rows.map(row => this.toView(row));
  }

  get(id: string): Connector | null {
    const row = this.db.prepare("SELECT * FROM connectors WHERE id=? AND owner_id=?").get(id, this.ownerId()) as unknown as ConnectorRow | undefined;
    return row ? this.toView(row) : null;
  }

  bySlug(slug: string): Connector | null {
    const row = this.db.prepare("SELECT * FROM connectors WHERE owner_id=? AND slug=?").get(this.ownerId(), slug) as unknown as ConnectorRow | undefined;
    return row ? this.toView(row) : null;
  }

  create(input: {
    slug: string; name: string; kind: ConnectorKind; provider: ConnectorProvider;
    url: string; authKind: ConnectorAuthKind; enabled?: boolean;
    status?: ConnectorStatus; statusDetail?: string; accountLabel?: string; tools?: ConnectorTool[];
    credentials?: StoredConnectorCredentials;
  }): Connector {
    const id = randomUUID();
    const now = Date.now();
    const label = input.accountLabel?.trim() || (input.status === "connected" ? input.statusDetail?.trim() : "") || "";
    const config: StoredConfig = { url: input.url, authKind: input.authKind, ...(label ? { accountLabel: label } : {}) };
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO connectors(id,owner_id,slug,name,kind,provider,config_json,enabled,status,status_detail,tools_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, this.ownerId(), input.slug, input.name, input.kind, input.provider,
        JSON.stringify(config), input.enabled === false ? 0 : 1,
        input.status ?? "disconnected", input.statusDetail ?? "", JSON.stringify(input.tools ?? []), now, now,
      );
      if (input.credentials) {
        const sealed = this.cipher.seal(JSON.stringify(input.credentials), `connector:${id}`);
        this.db.prepare("INSERT INTO connector_credentials(connector_id,auth_type,credential_json,updated_at) VALUES(?,?,?,?)")
          .run(id, input.authKind, sealed, now);
      }
    });
    return this.get(id)!;
  }

  update(id: string, patch: {
    name?: string; url?: string; authKind?: ConnectorAuthKind; accountLabel?: string | null;
    enabled?: boolean; status?: ConnectorStatus; statusDetail?: string; tools?: ConnectorTool[];
  }): Connector | null {
    const row = this.db.prepare("SELECT * FROM connectors WHERE id=? AND owner_id=?").get(id, this.ownerId()) as unknown as ConnectorRow | undefined;
    if (!row) return null;
    const config = this.parseJson<StoredConfig>(row.config_json, {});
    if (patch.url !== undefined) config.url = patch.url;
    if (patch.authKind !== undefined) config.authKind = patch.authKind;
    if (patch.accountLabel === null) delete config.accountLabel;
    else if (patch.accountLabel !== undefined && patch.accountLabel.trim()) config.accountLabel = patch.accountLabel.trim();
    else if (patch.status === "connected" && patch.statusDetail?.trim()) config.accountLabel = patch.statusDetail.trim();
    const sets: string[] = ["config_json=?", "updated_at=?"];
    const params: (string | number)[] = [JSON.stringify(config), Date.now()];
    if (patch.name !== undefined) { sets.push("name=?"); params.push(patch.name); }
    if (patch.enabled !== undefined) { sets.push("enabled=?"); params.push(patch.enabled ? 1 : 0); }
    if (patch.status !== undefined) { sets.push("status=?"); params.push(patch.status); }
    if (patch.statusDetail !== undefined) { sets.push("status_detail=?"); params.push(patch.statusDetail); }
    if (patch.tools !== undefined) { sets.push("tools_json=?"); params.push(JSON.stringify(patch.tools)); }
    params.push(id, this.ownerId());
    this.db.prepare(`UPDATE connectors SET ${sets.join(", ")} WHERE id=? AND owner_id=?`).run(...params);
    return this.get(id);
  }

  /** Replaces the set of write tools that bypass confirmation, binding each to its current definition hash. */
  setUnconfirmed(id: string, entries: { name: string; hash: string }[]): void {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM connector_unconfirmed_tools WHERE connector_id=?").run(id);
      const insert = this.db.prepare("INSERT INTO connector_unconfirmed_tools(connector_id,tool_name,definition_hash) VALUES(?,?,?)");
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        insert.run(id, entry.name, entry.hash);
      }
    });
  }

  /** Grants "don't ask again" for one write tool, fingerprinted by its current definition hash. */
  allowUnconfirmed(id: string, toolName: string, hash: string): void {
    this.db.prepare(`INSERT INTO connector_unconfirmed_tools(connector_id,tool_name,definition_hash) VALUES(?,?,?)
      ON CONFLICT(connector_id,tool_name) DO UPDATE SET definition_hash=excluded.definition_hash`).run(id, toolName, hash);
  }

  /** Checks whether a write tool's approval is present AND still matches its current definition hash. */
  isUnconfirmed(id: string, tool: ConnectorTool): boolean {
    const row = this.db.prepare("SELECT definition_hash AS hash FROM connector_unconfirmed_tools WHERE connector_id=? AND tool_name=?")
      .get(id, tool.name) as { hash: string } | undefined;
    return Boolean(row && row.hash && row.hash === toolDefinitionHash(tool));
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM connectors WHERE id=? AND owner_id=?").run(id, this.ownerId()).changes) > 0;
  }

  credentials(id: string): StoredConnectorCredentials | null {
    const row = this.db.prepare("SELECT cred.credential_json AS json FROM connector_credentials cred JOIN connectors c ON c.id=cred.connector_id WHERE c.id=? AND c.owner_id=?")
      .get(id, this.ownerId()) as { json: string } | undefined;
    if (!row) return {};
    const plain = this.cipher.open(row.json, `connector:${id}`);
    return plain === null ? null : this.parseJson<StoredConnectorCredentials>(plain, {});
  }

  /** Stable hash of the connector's credential identity (headers, OAuth client/refresh or access token) so pending
   * write confirmations are invalidated if credentials or accounts change before dispatch. */
  credentialFingerprint(id: string): string {
    const row = this.db.prepare("SELECT cred.auth_type AS authType, cred.credential_json AS json FROM connector_credentials cred JOIN connectors c ON c.id=cred.connector_id WHERE c.id=? AND c.owner_id=?")
      .get(id, this.ownerId()) as { authType: string; json: string } | undefined;
    if (!row) return "none";
    const plain = this.cipher.open(row.json, `connector:${id}`);
    if (plain === null) return "unreadable";
    return hashCredentials(row.authType, this.parseJson<StoredConnectorCredentials>(plain, {}));
  }

  saveCredentials(id: string, authKind: ConnectorAuthKind, credentials: StoredConnectorCredentials): void {
    const sealed = this.cipher.seal(JSON.stringify(credentials), `connector:${id}`);
    this.db.prepare(`INSERT INTO connector_credentials(connector_id,auth_type,credential_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(connector_id) DO UPDATE SET auth_type=excluded.auth_type, credential_json=excluded.credential_json, updated_at=excluded.updated_at`)
      .run(id, authKind, sealed, Date.now());
  }

  grant(id: string, botId: string, scope: GrantScope = "always", runId: string | null = null): void {
    this.db.prepare(`INSERT INTO connector_grants(connector_id,bot_id,scope,run_id,granted_by,granted_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(connector_id,bot_id) DO UPDATE SET scope=excluded.scope, run_id=excluded.run_id, granted_at=excluded.granted_at`)
      .run(id, botId, scope, runId, this.ownerId(), Date.now());
  }

  revoke(id: string, botId: string): boolean {
    return Number(this.db.prepare("DELETE FROM connector_grants WHERE connector_id=? AND bot_id=?").run(id, botId).changes) > 0;
  }

  /** Active grants for one Bot: permanent grants plus "this time only" grants whose run is still live. */
  grantedTo(botId: string): Map<string, GrantScope> {
    const rows = this.db.prepare(`SELECT g.connector_id AS id, g.scope FROM connector_grants g JOIN connectors c ON c.id=g.connector_id
      WHERE g.bot_id=? AND c.owner_id=? AND (g.scope='always' OR EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=g.run_id AND r.ended_at IS NULL))`)
      .all(botId, this.ownerId()) as { id: string; scope: GrantScope }[];
    return new Map(rows.map(row => [row.id, row.scope]));
  }

  grantedIds(botId: string): Set<string> {
    return new Set(this.grantedTo(botId).keys());
  }

  /** The Bot's run in progress, which a "this time only" grant lasts for. */
  currentRun(botId: string): string | null {
    return (this.db.prepare("SELECT id FROM bot_runs WHERE bot_id=? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1").get(botId) as { id: string } | undefined)?.id ?? null;
  }

  /** Checks whether a specific captured run ID for this Bot is still live (never falls back to a later run). */
  isRunLive(runId: string, botId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM bot_runs WHERE id=? AND bot_id=? AND ended_at IS NULL").get(runId, botId));
  }

  /** Removes expired "this time only" grants whose run has ended. */
  private purge(): void {
    this.db.prepare("DELETE FROM connector_grants WHERE scope='once' AND NOT EXISTS(SELECT 1 FROM bot_runs r WHERE r.id=connector_grants.run_id AND r.ended_at IS NULL)").run();
  }

  recordUse(use: { connectorId: string; slug: string; botId: string; toolName: string; outcome: "ok" | "error" | "denied"; detail: string }): void {
    this.db.prepare("INSERT INTO connector_uses(connector_id,connector_slug,bot_id,at,tool_name,outcome,detail) VALUES(?,?,?,?,?,?,?)")
      .run(use.connectorId, use.slug, use.botId, Date.now(), use.toolName, use.outcome, use.detail.slice(0, 500));
  }

  uses(id: string, limit = 100): ConnectorUse[] {
    return (this.db.prepare(`SELECT id, connector_slug AS connectorSlug, bot_id AS botId, at, tool_name AS toolName, outcome, detail
      FROM connector_uses WHERE connector_id=? ORDER BY at DESC, id DESC LIMIT ?`).all(id, limit) as unknown as ConnectorUse[]).map(use => ({ ...use }));
  }

  /** All secret tokens held by connectors and deployment env, so Masker redacts them everywhere. */
  secretValues(): { name: string; value: string }[] {
    const rows = this.db.prepare(`SELECT c.id, c.slug, cred.credential_json AS json FROM connectors c
      JOIN connector_credentials cred ON cred.connector_id=c.id WHERE c.owner_id=?`).all(this.ownerId()) as { id: string; slug: string; json: string }[];
    const found: { name: string; value: string }[] = [];
    for (const row of rows) {
      const plain = this.cipher.open(row.json, `connector:${row.id}`);
      if (!plain) continue;
      const cred = this.parseJson<StoredConnectorCredentials>(plain, {});
      const tag = `CONNECTOR_${row.slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
      for (const value of Object.values(cred.headers ?? {})) if (value) found.push({ name: `${tag}_HEADER`, value });
      if (cred.clientSecret) found.push({ name: `${tag}_CLIENT_SECRET`, value: cred.clientSecret });
      if (cred.oauth?.tokens?.access_token) found.push({ name: `${tag}_TOKEN`, value: cred.oauth.tokens.access_token });
      if (cred.oauth?.tokens?.refresh_token) found.push({ name: `${tag}_REFRESH`, value: cred.oauth.tokens.refresh_token });
      const clientSecret = cred.oauth?.clientInformation?.client_secret;
      if (typeof clientSecret === "string" && clientSecret) found.push({ name: `${tag}_OAUTH_SECRET`, value: clientSecret });
    }
    return [...found, ...(this.runtime?.secrets() ?? [])];
  }
}
