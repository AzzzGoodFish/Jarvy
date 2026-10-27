import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConfiguredModel, ModelConnection } from "../../shared/models.js";
import { ConflictError, ValidationError } from "../../shared/errors.js";
import { modelApis } from "../pi/catalog.js";
import type { CredentialRepository } from "./credential-repository.js";
import { optionalText, requireText } from "./text.js";
import { transaction } from "./transaction.js";

export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_APIS = modelApis;
function optionalPositive(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10_000_000) throw new ValidationError(`Invalid ${label}`);
  return Number(value);
}
function normalizeModel(value: unknown): ConfiguredModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Invalid model");
  const input = value as Record<string, unknown>;
  const id = requireText(input.id, "Model ID", 200);
  const name = input.name === undefined ? id : optionalText(input.name, "Model name", 200) || id;
  if (input.reasoning !== undefined && typeof input.reasoning !== "boolean") throw new ValidationError("Invalid reasoning capability");
  const capabilities = input.input === undefined ? ["text"] : input.input;
  if (!Array.isArray(capabilities) || !capabilities.length || !capabilities.includes("text") ||
      capabilities.some(item => item !== "text" && item !== "image")) throw new ValidationError("Invalid input capabilities");
  const thinkingFormat = input.thinkingFormat === undefined ? "" : optionalText(input.thinkingFormat, "Thinking format", 100);
  const rawMap = input.thinkingLevelMap ?? {};
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap) ||
      Object.entries(rawMap).some(([level, setting]) => !THINKING_LEVELS.has(level) || (setting !== null && (typeof setting !== "string" || setting.length > 80))))
    throw new ValidationError("Invalid thinking level map");
  let cost: ConfiguredModel["cost"] = null;
  if (input.cost !== null && input.cost !== undefined) {
    if (typeof input.cost !== "object" || Array.isArray(input.cost)) throw new ValidationError("Invalid model cost");
    const rates = input.cost as Record<string, unknown>;
    if (["input", "output", "cacheRead", "cacheWrite"].some(key => typeof rates[key] !== "number" || !Number.isFinite(rates[key]) || Number(rates[key]) < 0)) throw new ValidationError("Invalid model cost");
    cost = { input: Number(rates.input), output: Number(rates.output), cacheRead: Number(rates.cacheRead), cacheWrite: Number(rates.cacheWrite) };
  }
  if (input.api && (typeof input.api !== "string" || !MODEL_APIS.has(input.api))) throw new ValidationError("Invalid model API");
  // Pi compat flags vary by protocol and SDK version, so the store checks shape and size only;
  // thinkingFormat lives in its own field. Rows saved before compat existed read as {}.
  const rawCompat = input.compat ?? {};
  if (typeof rawCompat !== "object" || Array.isArray(rawCompat) || JSON.stringify(rawCompat).length > 16_000) throw new ValidationError("Invalid model compat");
  const { thinkingFormat: _format, ...compat } = rawCompat as Record<string, unknown>;
  return { id, name, ...(input.api ? { api: input.api as string } : {}), headerNames: Object.keys((input.headers ?? {}) as object), reasoning: input.reasoning === true,
    input: [...new Set(capabilities)] as ("text" | "image")[],
    contextWindow: optionalPositive(input.contextWindow, "context window"),
    maxTokens: optionalPositive(input.maxTokens, "max output tokens"),
    thinkingFormat, thinkingLevelMap: rawMap as Record<string, string | null>, compat, cost };
}

/** The owner's model connections: provider, address and protocol, whether a credential is kept, and the models
 * configured on each, with their headers. Credentials themselves are sealed by CredentialRepository. */
export class ModelConnectionRepository {
  constructor(private readonly db: DatabaseSync, private readonly credentials: CredentialRepository, private readonly ownerId: () => string) {}

  list(): ModelConnection[] {
    const rows = this.db.prepare(`SELECT c.id,c.provider_name AS providerName,c.display_name AS displayName,c.kind,c.auth_type AS authType,
      c.base_url AS baseUrl,c.api,c.created_at AS createdAt,c.updated_at AS updatedAt,
      p.type AS credentialType FROM provider_connections c LEFT JOIN provider_credentials p ON p.connection_id=c.id
      WHERE c.owner_id=? ORDER BY c.created_at,c.id`).all(this.ownerId()) as unknown as (Omit<ModelConnection, "models" | "configured"> & { credentialType: string | null })[];
    const models = this.db.prepare("SELECT m.connection_id AS connectionId,m.config_json AS configJson FROM connection_models m JOIN provider_connections c ON c.id=m.connection_id WHERE c.owner_id=? ORDER BY m.created_at,m.model_id")
      .all(this.ownerId()) as { connectionId: string; configJson: string }[];
    const byConnection = new Map<string, ConfiguredModel[]>();
    for (const row of models) byConnection.set(row.connectionId, [...(byConnection.get(row.connectionId) ?? []), normalizeModel(JSON.parse(row.configJson))]);
    return rows.map(row => ({ id: row.id, providerName: row.providerName, displayName: row.displayName, kind: row.kind,
      baseUrl: row.baseUrl, api: row.api, authType: row.authType, configured: row.credentialType !== null,
      models: byConnection.get(row.id) ?? [],
      createdAt: row.createdAt, updatedAt: row.updatedAt }));
  }
  get(id: string): ModelConnection | null { return this.list().find(row => row.id === id) ?? null; }
  create(input: Record<string, unknown>): ModelConnection {
    const providerName = requireText(input.providerName, "Provider name", 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerName)) throw new ValidationError("Invalid provider name");
    const displayName = requireText(input.displayName, "Connection name", 100);
    const kind = input.kind === "builtin" ? "builtin" : "custom";
    const authType = input.authType === "oauth" ? "oauth" : "api_key";
    if (kind === "custom") this.checkCustomName(providerName);
    const api = input.api === undefined ? (providerName === "openai-codex" ? "openai-codex-responses" : "openai-completions") : requireText(input.api, "API", 80);
    if (!MODEL_APIS.has(api)) throw new ValidationError("Unsupported API protocol");
    const baseUrl = input.baseUrl === undefined ? "" : optionalText(input.baseUrl, "Base URL", 2048);
    if (baseUrl) { const url = new URL(baseUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ValidationError("Invalid model URL"); }
    const key = input.apiKey === undefined ? null : requireText(input.apiKey, "API Key", 8192);
    if (key && authType !== "api_key") throw new ValidationError("Invalid credential type");
    const id = randomUUID(), now = Date.now();
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO provider_connections(id,provider_name,display_name,kind,auth_type,base_url,api,created_at,updated_at,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(id, providerName, displayName, kind, authType, baseUrl, api, now, now, this.ownerId());
      if (key) this.db.prepare("INSERT INTO provider_credentials(connection_id,type,credential_json,updated_at) VALUES(?,'api_key',?,?)")
        .run(id, this.credentials.stored(id, { type: "api_key", key }), now);
    });
    return this.get(id)!;
  }
  private checkCustomName(name: string, except = ""): void {
    if (this.db.prepare("SELECT 1 FROM provider_connections WHERE owner_id=? AND kind='custom' AND provider_name=? AND id<>?").get(this.ownerId(), name, except)) throw new ValidationError("A provider with this name already exists", "provider_name_taken");
  }
  update(id: string, input: Record<string, unknown>): ModelConnection | null {
    const current = this.get(id);
    if (!current) return null;
    const providerName = current.kind === "custom" && input.providerName !== undefined ? requireText(input.providerName, "Provider name", 80).toLowerCase() : current.providerName;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerName)) throw new ValidationError("Invalid provider name");
    if (current.kind === "custom") this.checkCustomName(providerName, id);
    const name = requireText(input.displayName, "Connection name", 100);
    const baseUrl = optionalText(input.baseUrl, "Base URL", 2048);
    if (baseUrl) { const url = new URL(baseUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ValidationError("Invalid model URL"); }
    const api = requireText(input.api, "API", 80);
    if (!MODEL_APIS.has(api)) throw new ValidationError("Unsupported API protocol");
    this.db.prepare("UPDATE provider_connections SET display_name=?,base_url=?,api=?,updated_at=?,provider_name=? WHERE id=?")
      .run(name, baseUrl, api, Date.now(), providerName, id);
    return this.get(id);
  }
  /** Deleted Bots keep their row (deleteBot) but use nothing: their link to the connection is cleared with it. */
  delete(id: string): boolean {
    if (!this.get(id)) return false;
    const users = (this.db.prepare("SELECT name FROM bots WHERE connection_id=? AND deleted_at IS NULL ORDER BY name").all(id) as { name: string }[]).map(row => row.name);
    if (users.length) throw new ConflictError(`In use by ${users.join(", ")}`, "connection_in_use", { bots: users.join(", "), count: users.length });
    return transaction(this.db, () => {
      this.db.prepare("UPDATE bots SET connection_id=NULL WHERE connection_id=? AND deleted_at IS NOT NULL").run(id);
      const deleted = Number(this.db.prepare("DELETE FROM provider_connections WHERE id=?").run(id).changes) > 0;
      return deleted;
    });
  }
  saveCredential(id: string, input: Record<string, unknown>): ModelConnection | null {
    const connection = this.get(id);
    if (!connection) return null;
    if (connection.authType !== "api_key") throw new ValidationError("Invalid credential type; use OAuth login");
    if (input.remove === true) this.db.prepare("DELETE FROM provider_credentials WHERE connection_id=?").run(id);
    else if (input.apiKey !== undefined) {
      const key = requireText(input.apiKey, "API Key", 8192);
      this.db.prepare(`INSERT INTO provider_credentials(connection_id,type,credential_json,updated_at) VALUES(?,'api_key',?,?)
        ON CONFLICT(connection_id) DO UPDATE SET type='api_key',credential_json=excluded.credential_json,updated_at=excluded.updated_at`)
        .run(id, this.credentials.stored(id, { type: "api_key", key }), Date.now());
    }
    return this.get(id);
  }
  headers(id: string, modelId: string): Record<string, string> {
    if (!this.get(id)) return {};
    const row = this.db.prepare("SELECT config_json FROM connection_models WHERE connection_id=? AND model_id=?").get(id, modelId) as { config_json: string } | undefined;
    return row ? JSON.parse(row.config_json).headers ?? {} : {};
  }
  saveModel(id: string, raw: unknown, originalId?: string): ModelConnection | null {
    if (!this.get(id)) return null;
    const model = normalizeModel(raw), now = Date.now();
    const headers = new Headers(this.headers(id, originalId ?? model.id));
    const updates = (raw as Record<string, unknown>).headerUpdates;
    if (updates !== undefined) {
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new ValidationError("Invalid headers");
      for (const [name, value] of Object.entries(updates)) {
        if (value === null) headers.delete(name);
        else if (typeof value === "string") headers.set(name, value);
        else throw new ValidationError("Invalid header value");
      }
    }
    const literalHeaders: Record<string, string> = {};
    headers.forEach((value, name) => { literalHeaders[name] = value; });
    const stored = { ...model, headers: literalHeaders };
    transaction(this.db, () => {
      if (originalId && originalId !== model.id) {
        if (!this.db.prepare("SELECT 1 FROM connection_models WHERE connection_id=? AND model_id=?").get(id, originalId)) throw new ConflictError("Original model not found");
        if (this.db.prepare("SELECT 1 FROM connection_models WHERE connection_id=? AND model_id=?").get(id, model.id)) throw new ConflictError("Model ID already exists");
        this.db.prepare("UPDATE connection_models SET model_id=?,config_json=?,updated_at=? WHERE connection_id=? AND model_id=?")
          .run(model.id, JSON.stringify(stored), now, id, originalId);
        this.db.prepare("UPDATE bots SET model_id=? WHERE connection_id=? AND model_id=?").run(model.id, id, originalId);
      } else this.db.prepare(`INSERT INTO connection_models(connection_id,model_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(connection_id,model_id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at`)
        .run(id, model.id, JSON.stringify(stored), now, now);
    });
    return this.get(id);
  }
  deleteModel(id: string, modelId: string): ModelConnection | null {
    if (!this.get(id)) return null;
    if (this.db.prepare("SELECT 1 FROM bots WHERE connection_id=? AND model_id=? LIMIT 1").get(id, modelId)) throw new ConflictError("A Bot is using this model");
    this.db.prepare("DELETE FROM connection_models WHERE connection_id=? AND model_id=?").run(id, modelId);
    return this.get(id);
  }
}
