import { BOT_COLORS, type Bot, type BotColor, type ConfiguredModel, type ModelConnection } from "../../shared/models.js";
import { ValidationError, ConflictError } from "../../shared/errors.js";
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations/schema.js";
import { ChatRepository } from "./chat-repository.js";
import { RuntimeRepository } from "./runtime-repository.js";
import { modelApis } from "../pi/catalog.js";
import { CredentialRepository } from "./credential-repository.js";
import { AgentRepository } from "./agent-repository.js";
import { EnvironmentRepository } from "./environment-repository.js";
import type { ModelSelection } from "../../shared/runtime.js";

export const defaultDataDir = () => process.env.JARVY_DATA_DIR || join(homedir(), ".jarvy");
export const DATABASE_FILENAME = "jarvy.db";
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;


function passwordHash(password: string, salt: string): string {
  return scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex");
}
function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new ValidationError(`${label} must be 1-${max} characters`);
  return value.trim();
}
function optionalText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new ValidationError(`${label} must be at most ${max} characters`);
  return value.trim();
}
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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

/** SQLite owner. Runtime adapters never receive the raw database handle. */
export class Store {
  private readonly db: DatabaseSync;
  readonly path: string;
  readonly chats: ChatRepository;
  readonly runtime: RuntimeRepository;
  readonly credentials: CredentialRepository;
  readonly agent: AgentRepository;
  readonly environments: EnvironmentRepository;

  constructor(dataDir = defaultDataDir()) {
    const root = resolve(dataDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.path = join(root, DATABASE_FILENAME);
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    try { migrateDatabase(this.db); }
    catch (error) { this.db.close(); throw error; }
    this.chats = new ChatRepository(this.db);
    this.runtime = new RuntimeRepository(this.db);
    this.credentials = new CredentialRepository(this.db);
    this.agent = new AgentRepository(this.db, () => this.userMemberId());
    this.environments = new EnvironmentRepository(this.db, () => this.userMemberId());
    this.agent.ensure();
  }

  close(): void { this.db.close(); }
  /** Installation identity, not an account/connection ID. Pi requests it only for ChatGPT login. */
  installationDeviceId(): string {
    const row = this.db.prepare("SELECT device_id FROM installation WHERE id=1").get() as { device_id: string } | undefined;
    if (row) return row.device_id;
    const id = randomUUID();
    this.db.prepare("INSERT INTO installation(id,device_id) VALUES(1,?)").run(id);
    return id;
  }
  userMemberId(): string {
    const account = this.db.prepare("SELECT member_id AS id FROM account WHERE id=1").get() as { id: string } | undefined;
    // Before account initialization, migrations have reserved one owner identity.
    return account?.id ?? (this.db.prepare("SELECT id FROM members WHERE kind='user' ORDER BY rowid LIMIT 1").get() as { id: string }).id;
  }
  isInitialized(): boolean { return !!this.db.prepare("SELECT 1 FROM account WHERE id=1").get(); }
  username(): string | null {
    return (this.db.prepare("SELECT username FROM account WHERE id=1").get() as { username: string } | undefined)?.username ?? null;
  }
  initialize(username: unknown, password: unknown): void {
    const name = requireText(username, "Username", 64);
    if (typeof password !== "string" || password.length < 8 || password.length > 256) throw new ValidationError("Password must be 8-256 characters");
    const salt = randomBytes(16).toString("hex");
    const digest = passwordHash(password, salt);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.isInitialized()) throw new ConflictError("Account is already initialized");
      this.db.prepare("INSERT INTO account(id,username,password_salt,password_hash,member_id) VALUES(1,?,?,?,?)").run(name, salt, digest, this.userMemberId());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  login(username: unknown, password: unknown): string | null {
    const row = this.db.prepare("SELECT username,password_salt,password_hash FROM account WHERE id=1").get() as
      { username: string; password_salt: string; password_hash: string } | undefined;
    if (!row || typeof username !== "string" || typeof password !== "string") return null;
    const candidate = Buffer.from(passwordHash(password, row.password_salt), "hex");
    const expected = Buffer.from(row.password_hash, "hex");
    if (!timingSafeEqual(candidate, expected) || username !== row.username) return null;
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at<?").run(Date.now());
    this.db.prepare("INSERT INTO auth_sessions VALUES (?,?)").run(tokenHash(token), Date.now() + SESSION_LIFETIME_MS);
    return token;
  }
  authenticated(token: string | undefined): boolean {
    if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return false;
    return !!this.db.prepare("SELECT 1 FROM auth_sessions WHERE token_hash=? AND expires_at>?").get(tokenHash(token), Date.now());
  }
  logout(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(tokenHash(token));
  }
  private botFromRow(row: Omit<Bot, "workspacePath">): Bot {
    const workspacePath = join(dirname(this.path), "bots", row.id, "workspace");
    mkdirSync(join(workspacePath, "temp"), { recursive: true, mode: 0o700 });
    return { ...row, workspacePath };
  }
  listBots(): Bot[] {
    const rows = this.db.prepare("SELECT id,name,description,system_prompt AS systemPrompt,connection_id AS connectionId,model_id AS modelId,thinking_level AS thinkingLevel,color,mood,created_at AS createdAt FROM bots WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at,id")
      .all(this.userMemberId()) as unknown as Omit<Bot, "workspacePath">[];
    return rows.map(row => this.botFromRow(row));
  }
  getBot(id: string): Bot | null {
    const row = this.db.prepare("SELECT id,name,description,system_prompt AS systemPrompt,connection_id AS connectionId,model_id AS modelId,thinking_level AS thinkingLevel,color,mood,created_at AS createdAt FROM bots WHERE id=? AND owner_id=? AND deleted_at IS NULL")
      .get(id, this.userMemberId()) as Omit<Bot, "workspacePath"> | undefined;
    return row ? this.botFromRow(row) : null;
  }
  /** Member names are unique across people and Bots, ignoring case, so "@name" in a message is unambiguous (A37). */
  private nameTaken(name: string, exceptBotId?: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM account WHERE lower(username)=lower(:name)
      UNION ALL SELECT 1 FROM bots WHERE lower(name)=lower(:name) AND id<>:except AND deleted_at IS NULL LIMIT 1`).get({ name, except: exceptBotId ?? "" });
  }
  /** Deletes a Bot: its DMs (with anyone), channel memberships and states, queued deliveries,
   * notices and session row go; the member row stays, marked deleted, so messages it left in channels keep their
   * author, and its name is free again. Files are the caller's (BotService). */
  deleteBot(id: string): boolean {
    if (!this.getBot(id)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE bots SET deleted_at=? WHERE id=?").run(Date.now(), id);
      this.db.prepare("DELETE FROM chats WHERE type='dm' AND id IN (SELECT chat_id FROM chat_members WHERE member_id=?)").run(id);
      for (const table of ["chat_members", "chat_states", "inbox"]) this.db.prepare(`DELETE FROM ${table} WHERE member_id=?`).run(id);
      this.db.prepare("DELETE FROM bot_sessions WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM environment_grants WHERE bot_id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return true;
  }
  private botName(value: unknown, exceptBotId?: string): string {
    const name = requireText(value, "Bot name", 80);
    if (name.includes("@") || /[\n\r]/.test(name)) throw new ValidationError("Bot name cannot contain @ or line breaks");
    if (this.nameTaken(name, exceptBotId)) throw new ConflictError("Another member already has this name", "name_taken");
    return name;
  }
  /** The caller names the Bot (A45: the interface picks a free default in its own language). */
  createBot(name: unknown): Bot {
    const clean = this.botName(name);
    const id = randomUUID(), createdAt = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO members VALUES(?,'bot')").run(id);
      this.db.prepare("INSERT INTO bots(id,name,description,system_prompt,model_id,created_at,owner_id,thinking_level,color) VALUES(?,?,?,?,?,?,?,'auto',?)")
        .run(id, clean, "", "", "", createdAt, this.userMemberId(), BOT_COLORS[randomInt(BOT_COLORS.length)]!);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getBot(id)!;
  }
  updateBot(id: string, input: Record<string, unknown>): Bot | null {
    if (!this.getBot(id)) return null;
    const name = this.botName(input.name, id);
    const description = optionalText(input.description, "Description", 1000);
    const systemPrompt = optionalText(input.systemPrompt, "Persona", 16_000);
    if (!this.db.prepare("UPDATE bots SET name=?,description=?,system_prompt=? WHERE id=?")
      .run(name, description, systemPrompt, id).changes) return null;
    return this.getBot(id);
  }
  validateSelection(id: string, input: Record<string, unknown>): ModelSelection | null {
    const bot = this.getBot(id);
    if (!bot) return null;
    const connectionId = requireText(input.connectionId, "Connection ID", 80);
    const modelId = requireText(input.modelId, "Model ID", 200);
    const thinkingLevel = input.thinkingLevel === undefined ? bot.thinkingLevel : requireText(input.thinkingLevel, "Thinking level", 24);
    if (thinkingLevel !== "auto" && !THINKING_LEVELS.has(thinkingLevel)) throw new ValidationError("Invalid thinking level");
    if (!this.getModelConnection(connectionId) || !this.db.prepare("SELECT 1 FROM connection_models WHERE connection_id=? AND model_id=?").get(connectionId, modelId))
      throw new ConflictError("Model not found in this connection");
    return { connectionId, modelId, thinkingLevel };
  }
  listModelConnections(): ModelConnection[] {
    const rows = this.db.prepare(`SELECT c.id,c.provider_name AS providerName,c.display_name AS displayName,c.kind,c.auth_type AS authType,
      c.base_url AS baseUrl,c.api,c.created_at AS createdAt,c.updated_at AS updatedAt,
      p.type AS credentialType FROM provider_connections c LEFT JOIN provider_credentials p ON p.connection_id=c.id
      WHERE c.owner_id=? ORDER BY c.created_at,c.id`).all(this.userMemberId()) as unknown as (Omit<ModelConnection, "models" | "configured"> & { credentialType: string | null })[];
    const models = this.db.prepare("SELECT m.connection_id AS connectionId,m.config_json AS configJson FROM connection_models m JOIN provider_connections c ON c.id=m.connection_id WHERE c.owner_id=? ORDER BY m.created_at,m.model_id")
      .all(this.userMemberId()) as { connectionId: string; configJson: string }[];
    const byConnection = new Map<string, ConfiguredModel[]>();
    for (const row of models) byConnection.set(row.connectionId, [...(byConnection.get(row.connectionId) ?? []), normalizeModel(JSON.parse(row.configJson))]);
    return rows.map(row => ({ id: row.id, providerName: row.providerName, displayName: row.displayName, kind: row.kind,
      baseUrl: row.baseUrl, api: row.api, authType: row.authType, configured: row.credentialType !== null,
      models: byConnection.get(row.id) ?? [],
      createdAt: row.createdAt, updatedAt: row.updatedAt }));
  }
  getModelConnection(id: string): ModelConnection | null { return this.listModelConnections().find(row => row.id === id) ?? null; }
  createModelConnection(input: Record<string, unknown>): ModelConnection {
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO provider_connections(id,provider_name,display_name,kind,auth_type,base_url,api,created_at,updated_at,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(id, providerName, displayName, kind, authType, baseUrl, api, now, now, this.userMemberId());
      if (key) this.db.prepare("INSERT INTO provider_credentials(connection_id,type,credential_json,updated_at) VALUES(?,'api_key',?,?)")
        .run(id, JSON.stringify({ type: "api_key", key }), now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getModelConnection(id)!;
  }
  private checkCustomName(name: string, except = ""): void {
    if (this.db.prepare("SELECT 1 FROM provider_connections WHERE owner_id=? AND kind='custom' AND provider_name=? AND id<>?").get(this.userMemberId(), name, except)) throw new ValidationError("A provider with this name already exists", "provider_name_taken");
  }
  updateModelConnection(id: string, input: Record<string, unknown>): ModelConnection | null {
    const current = this.getModelConnection(id);
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
    return this.getModelConnection(id);
  }
  deleteModelConnection(id: string): boolean {
    if (!this.getModelConnection(id)) return false;
    if (this.db.prepare("SELECT 1 FROM bots WHERE connection_id=? LIMIT 1").get(id)) throw new ConflictError("A Bot is using this connection");
    return Number(this.db.prepare("DELETE FROM provider_connections WHERE id=?").run(id).changes) > 0;
  }
  saveModelCredential(id: string, input: Record<string, unknown>): ModelConnection | null {
    const connection = this.getModelConnection(id);
    if (!connection) return null;
    if (connection.authType !== "api_key") throw new ValidationError("Invalid credential type; use OAuth login");
    if (input.remove === true) this.db.prepare("DELETE FROM provider_credentials WHERE connection_id=?").run(id);
    else if (input.apiKey !== undefined) {
      const key = requireText(input.apiKey, "API Key", 8192);
      this.db.prepare(`INSERT INTO provider_credentials(connection_id,type,credential_json,updated_at) VALUES(?,'api_key',?,?)
        ON CONFLICT(connection_id) DO UPDATE SET type='api_key',credential_json=excluded.credential_json,updated_at=excluded.updated_at`)
        .run(id, JSON.stringify({ type: "api_key", key }), Date.now());
    }
    return this.getModelConnection(id);
  }
  modelHeaders(id: string, modelId: string): Record<string, string> {
    if (!this.getModelConnection(id)) return {};
    const row = this.db.prepare("SELECT config_json FROM connection_models WHERE connection_id=? AND model_id=?").get(id, modelId) as { config_json: string } | undefined;
    return row ? JSON.parse(row.config_json).headers ?? {} : {};
  }
  saveConnectionModel(id: string, raw: unknown, originalId?: string): ModelConnection | null {
    if (!this.getModelConnection(id)) return null;
    const model = normalizeModel(raw), now = Date.now();
    const headers = new Headers(this.modelHeaders(id, originalId ?? model.id));
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (originalId && originalId !== model.id) {
        if (!this.db.prepare("SELECT 1 FROM connection_models WHERE connection_id=? AND model_id=?").get(id, originalId)) throw new ConflictError("Original model not found");
        if (this.db.prepare("SELECT 1 FROM connection_models WHERE connection_id=? AND model_id=?").get(id, model.id)) throw new ConflictError("Model ID already exists");
        this.db.prepare("UPDATE connection_models SET model_id=?,config_json=?,updated_at=? WHERE connection_id=? AND model_id=?")
          .run(model.id, JSON.stringify(stored), now, id, originalId);
        this.db.prepare("UPDATE bots SET model_id=? WHERE connection_id=? AND model_id=?").run(model.id, id, originalId);
      } else this.db.prepare(`INSERT INTO connection_models(connection_id,model_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(connection_id,model_id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at`)
        .run(id, model.id, JSON.stringify(stored), now, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getModelConnection(id);
  }
  deleteConnectionModel(id: string, modelId: string): ModelConnection | null {
    if (!this.getModelConnection(id)) return null;
    if (this.db.prepare("SELECT 1 FROM bots WHERE connection_id=? AND model_id=? LIMIT 1").get(id, modelId)) throw new ConflictError("A Bot is using this model");
    this.db.prepare("DELETE FROM connection_models WHERE connection_id=? AND model_id=?").run(id, modelId);
    return this.getModelConnection(id);
  }
  setBotColor(id: string, color: unknown): Bot | null {
    if (!BOT_COLORS.includes(color as BotColor)) throw new ValidationError("Invalid Bot color");
    if (!this.getBot(id)) return null;
    this.db.prepare("UPDATE bots SET color=? WHERE id=?").run(color as string, id);
    return this.getBot(id);
  }
}
