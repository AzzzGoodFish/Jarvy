import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Connector, ConnectorAuthKind, ConnectorGrant, ConnectorKind, ConnectorProvider,
  ConnectorSafety, ConnectorStatus, ConnectorTool, ConnectorUse,
} from "../../../contract/connectors.js";
import type { StoredConnectorCredentials } from "../../shared/connector.js";
import { ConflictError } from "../../shared/errors.js";
import type { Cipher } from "../vault/cipher.js";

type Row = {
  id: string; slug: string; name: string; kind: ConnectorKind; provider: ConnectorProvider;
  configJson: string; safety: ConnectorSafety; enabled: number;
  status: ConnectorStatus; statusDetail: string; toolsJson: string;
  createdAt: number; updatedAt: number; uses: number; lastUsedAt: number | null;
  authType: ConnectorAuthKind | null; credentialJson: string | null;
};

interface ConnectorConfig { url?: string; authKind?: ConnectorAuthKind }

const COLUMNS = `c.id, c.slug, c.name, c.kind, c.provider, c.config_json AS configJson, c.safety,
  c.enabled, c.status, c.status_detail AS statusDetail, c.tools_json AS toolsJson, c.created_at AS createdAt, c.updated_at AS updatedAt,
  (SELECT count(*) FROM connector_uses u WHERE u.connector_id=c.id) AS uses,
  (SELECT max(at) FROM connector_uses u WHERE u.connector_id=c.id) AS lastUsedAt,
  cred.auth_type AS authType, cred.credential_json AS credentialJson`;

/** Connectors, sealed credentials, Bot grants and use logs (v32, A95). */
export class ConnectorRepository {
  constructor(private readonly db: DatabaseSync, private readonly cipher: Cipher, private readonly ownerId: () => string) {}

  private parseJson<T>(raw: string, fallback: T): T {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }

  private openCredentials(id: string, sealed: string | null): { readable: boolean; data: StoredConnectorCredentials } {
    if (!sealed) return { readable: true, data: {} };
    const plain = this.cipher.open(sealed, `connector:${id}`);
    if (plain === null) return { readable: false, data: {} };
    return { readable: true, data: this.parseJson<StoredConnectorCredentials>(plain, {}) };
  }

  private toRecord(row: Row): Connector {
    const config = this.parseJson<ConnectorConfig>(row.configJson, {});
    const tools = this.parseJson<ConnectorTool[]>(row.toolsJson, []);
    const grants = (this.db.prepare("SELECT bot_id AS botId, granted_at AS grantedAt FROM connector_grants WHERE connector_id=? ORDER BY granted_at")
      .all(row.id) as unknown as ConnectorGrant[]).map(grant => ({ ...grant }));
    const { readable, data } = this.openCredentials(row.id, row.credentialJson);
    const authKind: ConnectorAuthKind = row.authType ?? config.authKind ?? "none";
    const headerNames = Object.keys(data.headers ?? {}).sort();
    return {
      id: row.id, slug: row.slug, name: row.name, kind: row.kind, provider: row.provider,
      url: config.url ?? "", authKind, headerNames,
      oauthClientId: data.clientId ?? (typeof data.oauth?.clientInformation?.client_id === "string" ? data.oauth.clientInformation.client_id : null),
      hasClientSecret: Boolean(data.clientSecret || (typeof data.oauth?.clientInformation?.client_secret === "string" && data.oauth.clientInformation.client_secret)),
      safety: row.safety, enabled: row.enabled === 1,
      status: row.status, statusDetail: row.statusDetail, readable, tools, grants,
      uses: row.uses, lastUsedAt: row.lastUsedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  list(): Connector[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM connectors c LEFT JOIN connector_credentials cred ON cred.connector_id=c.id
      WHERE c.owner_id=? ORDER BY lower(c.name), c.created_at`).all(this.ownerId()) as unknown as Row[]).map(row => this.toRecord(row));
  }

  get(id: string): Connector | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM connectors c LEFT JOIN connector_credentials cred ON cred.connector_id=c.id
      WHERE c.id=? AND c.owner_id=?`).get(id, this.ownerId()) as unknown as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  bySlug(slug: string): Connector | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM connectors c LEFT JOIN connector_credentials cred ON cred.connector_id=c.id
      WHERE c.owner_id=? AND c.slug=?`).get(this.ownerId(), slug) as unknown as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  create(input: {
    slug: string; name: string; kind: ConnectorKind; provider: ConnectorProvider;
    url: string; authKind: ConnectorAuthKind; safety: ConnectorSafety;
    enabled: boolean; status: ConnectorStatus; statusDetail?: string; credentials?: StoredConnectorCredentials;
  }): Connector {
    if (this.db.prepare("SELECT 1 FROM connectors WHERE owner_id=? AND slug=?").get(this.ownerId(), input.slug))
      throw new ConflictError("Another connector uses this identifier", "connector_slug_taken");
    const id = randomUUID(), now = Date.now();
    const config: ConnectorConfig = { url: input.url, authKind: input.authKind };
    this.db.prepare(`INSERT INTO connectors(id,owner_id,slug,name,kind,provider,config_json,safety,enabled,status,status_detail,tools_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, this.ownerId(), input.slug, input.name, input.kind, input.provider, JSON.stringify(config), input.safety,
        input.enabled ? 1 : 0, input.status, input.statusDetail ?? "", "[]", now, now);
    this.saveCredentials(id, input.authKind, input.credentials ?? {});
    return this.get(id)!;
  }

  update(id: string, patch: {
    name?: string; url?: string; authKind?: ConnectorAuthKind; safety?: ConnectorSafety;
    enabled?: boolean; status?: ConnectorStatus; statusDetail?: string;
    tools?: ConnectorTool[];
  }): Connector | null {
    const existing = this.db.prepare("SELECT config_json AS configJson FROM connectors WHERE id=? AND owner_id=?").get(id, this.ownerId()) as { configJson: string } | undefined;
    if (!existing) return null;
    const config = this.parseJson<ConnectorConfig>(existing.configJson, {});
    if (patch.url !== undefined) config.url = patch.url;
    if (patch.authKind !== undefined) config.authKind = patch.authKind;
    const sets: string[] = ["updated_at=?"];
    const params: (string | number)[] = [Date.now()];
    if (patch.name !== undefined) { sets.push("name=?"); params.push(patch.name); }
    if (patch.url !== undefined || patch.authKind !== undefined) { sets.push("config_json=?"); params.push(JSON.stringify(config)); }
    if (patch.safety !== undefined) { sets.push("safety=?"); params.push(patch.safety); }
    if (patch.enabled !== undefined) { sets.push("enabled=?"); params.push(patch.enabled ? 1 : 0); }
    if (patch.status !== undefined) { sets.push("status=?"); params.push(patch.status); }
    if (patch.statusDetail !== undefined) { sets.push("status_detail=?"); params.push(patch.statusDetail); }
    if (patch.tools !== undefined) { sets.push("tools_json=?"); params.push(JSON.stringify(patch.tools)); }
    params.push(id, this.ownerId());
    this.db.prepare(`UPDATE connectors SET ${sets.join(", ")} WHERE id=? AND owner_id=?`).run(...params);
    return this.get(id);
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

  saveCredentials(id: string, authKind: ConnectorAuthKind, credentials: StoredConnectorCredentials): void {
    const sealed = this.cipher.seal(JSON.stringify(credentials), `connector:${id}`);
    this.db.prepare(`INSERT INTO connector_credentials(connector_id,auth_type,credential_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(connector_id) DO UPDATE SET auth_type=excluded.auth_type, credential_json=excluded.credential_json, updated_at=excluded.updated_at`)
      .run(id, authKind, sealed, Date.now());
  }

  grant(id: string, botId: string): void {
    this.db.prepare(`INSERT INTO connector_grants(connector_id,bot_id,granted_by,granted_at) VALUES(?,?,?,?)
      ON CONFLICT(connector_id,bot_id) DO NOTHING`).run(id, botId, this.ownerId(), Date.now());
  }

  revoke(id: string, botId: string): boolean {
    return Number(this.db.prepare("DELETE FROM connector_grants WHERE connector_id=? AND bot_id=?").run(id, botId).changes) > 0;
  }

  grantedIds(botId: string): Set<string> {
    const rows = this.db.prepare("SELECT g.connector_id AS id FROM connector_grants g JOIN connectors c ON c.id=g.connector_id WHERE g.bot_id=? AND c.owner_id=?")
      .all(botId, this.ownerId()) as { id: string }[];
    return new Set(rows.map(row => row.id));
  }

  recordUse(use: { connectorId: string; slug: string; botId: string; toolName: string; outcome: "ok" | "error" | "denied"; detail: string }): void {
    this.db.prepare("INSERT INTO connector_uses(connector_id,connector_slug,bot_id,at,tool_name,outcome,detail) VALUES(?,?,?,?,?,?,?)")
      .run(use.connectorId, use.slug, use.botId, Date.now(), use.toolName, use.outcome, use.detail.slice(0, 500));
  }

  uses(id: string, limit = 100): ConnectorUse[] {
    return (this.db.prepare(`SELECT id, connector_slug AS connectorSlug, bot_id AS botId, at, tool_name AS toolName, outcome, detail
      FROM connector_uses WHERE connector_id=? ORDER BY at DESC, id DESC LIMIT ?`).all(id, limit) as unknown as ConnectorUse[]).map(use => ({ ...use }));
  }

  /** All secret tokens held by connectors, so Masker redacts them everywhere. */
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
    return found;
  }
}
