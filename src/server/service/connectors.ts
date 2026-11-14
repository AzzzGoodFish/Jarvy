import type {
  Connector, ConnectorAuthKind, ConnectorOAuthState, ConnectorPreset,
  ConnectorProvider, ConnectorSafety, ConnectorTool, ConnectorUse,
} from "../../contract/connectors.js";
import type { QuestionSpec } from "../../contract/chat.js";
import type { ChatMessage } from "../shared/chat.js";
import {
  CONNECTOR_PRESETS, isWriteTool,
  type McpDriver, type StoredConnectorCredentials,
} from "../shared/connector.js";
import type { Store } from "../infra/storage/store.js";
import { ChatError } from "../shared/chat.js";
import { RuntimeFault } from "../shared/runtime.js";
import { ValidationError } from "../shared/errors.js";
import type { ChatService } from "./chat/service.js";
import type { SecretService } from "./secrets.js";
import type { Listening } from "./connection.js";
import type { QuestionResult } from "./chat/questions.js";
import { ConnectorOAuthCoordinator } from "./connectors-oauth.js";
import { buildWriteFields, cleanHeaders, cleanName, cleanSlug, cleanUrl, humanizeKey } from "./connectors-format.js";

const MAX_TOOL_TEXT = 32_000;
const AUTH_KINDS = new Set<ConnectorAuthKind>(["none", "headers", "oauth"]);
const SAFETIES = new Set<ConnectorSafety>(["read_only", "confirm_writes", "auto"]);
const PROVIDERS = new Set<ConnectorProvider>(["custom_mcp", "linear", "notion", "figma", "github", "gmail", "slack"]);
const DUAL_AUTH_PROVIDERS = new Set<ConnectorProvider>(["custom_mcp", "github", "slack"]);

/** Connectors (A94): remote MCP servers (and future built-in adapters), sealed credentials, per-Bot grants and usage. */
export class ConnectorService {
  private readonly locks = new Map<string, Promise<unknown>>();
  readonly oauth: ConnectorOAuthCoordinator;

  constructor(
    private readonly store: Store,
    private readonly chats: ChatService,
    private readonly secrets: SecretService,
    private readonly driver: McpDriver,
    listening: () => Listening | null,
  ) {
    this.oauth = new ConnectorOAuthCoordinator(
      store,
      driver,
      listening,
      (id, work) => this.withLock(id, work),
      id => this.probeLocked(id).then(() => {}),
      () => this.secrets.refreshMask(),
    );
  }

  presets(): ConnectorPreset[] {
    return CONNECTOR_PRESETS.map(preset => ({ ...preset }));
  }

  list(): Connector[] { return this.store.connectors.list(); }

  get(id: string): Connector { return this.store.connectors.get(id) ?? this.missing(); }

  async create(input: {
    slug?: unknown; name?: unknown; provider?: unknown; url?: unknown; authKind?: unknown;
    headers?: unknown; clientId?: unknown; clientSecret?: unknown; safety?: unknown;
  }): Promise<Connector> {
    const provider: ConnectorProvider = typeof input.provider === "string" && PROVIDERS.has(input.provider as ConnectorProvider)
      ? (input.provider as ConnectorProvider) : "custom_mcp";
    const preset = CONNECTOR_PRESETS.find(item => item.id === provider);
    const slug = input.slug !== undefined && input.slug !== ""
      ? cleanSlug(input.slug)
      : this.freeSlug(provider !== "custom_mcp" ? provider : "mcp");
    const name = cleanName(input.name, preset?.name ?? slug);
    const kind = preset?.kind ?? "remote_mcp";
    const url = cleanUrl(provider !== "custom_mcp" ? preset?.url : (input.url ?? preset?.url));
    const authKind: ConnectorAuthKind = DUAL_AUTH_PROVIDERS.has(provider)
      && typeof input.authKind === "string" && AUTH_KINDS.has(input.authKind as ConnectorAuthKind)
      ? (input.authKind as ConnectorAuthKind) : (preset?.authKind ?? "oauth");
    const safety: ConnectorSafety = typeof input.safety === "string" && SAFETIES.has(input.safety as ConnectorSafety)
      ? (input.safety as ConnectorSafety) : "confirm_writes";
    const headers = cleanHeaders(input.headers);
    const clientId = typeof input.clientId === "string" && input.clientId.trim() ? input.clientId.trim() : undefined;
    const clientSecret = typeof input.clientSecret === "string" && input.clientSecret.trim() ? input.clientSecret.trim() : undefined;

    const credentials: StoredConnectorCredentials = {
      ...(headers && Object.keys(headers).length ? { headers } : {}),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    };
    const created = this.store.connectors.create({
      slug, name, kind, provider, url, authKind, safety,
      enabled: true, status: authKind === "oauth" ? "needs_auth" : "disconnected", credentials,
    });
    this.secrets.refreshMask();
    if (authKind !== "oauth") return this.probe(created.id).catch(() => this.get(created.id));
    return created;
  }

  async update(id: string, input: {
    name?: unknown; url?: unknown; authKind?: unknown; headers?: unknown;
    clientId?: unknown; clientSecret?: unknown; safety?: unknown; enabled?: unknown;
  }): Promise<Connector> {
    const current = this.get(id);
    const patch: Parameters<Store["connectors"]["update"]>[1] = {};
    if (input.name !== undefined) patch.name = cleanName(input.name, current.name);
    if (input.url !== undefined && current.provider === "custom_mcp") patch.url = cleanUrl(input.url);
    if (input.authKind !== undefined && DUAL_AUTH_PROVIDERS.has(current.provider)) {
      if (typeof input.authKind !== "string" || !AUTH_KINDS.has(input.authKind as ConnectorAuthKind))
        throw new ValidationError("Invalid auth kind", "type_invalid");
      patch.authKind = input.authKind as ConnectorAuthKind;
    }
    if (input.safety !== undefined) {
      if (typeof input.safety !== "string" || !SAFETIES.has(input.safety as ConnectorSafety))
        throw new ValidationError("Invalid safety policy", "type_invalid");
      patch.safety = input.safety as ConnectorSafety;
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw new ValidationError("enabled must be boolean", "type_invalid");
      patch.enabled = input.enabled;
    }

    const nextAuth = patch.authKind ?? current.authKind;
    const headers = cleanHeaders(input.headers);
    const existingCreds = this.store.connectors.credentials(id) ?? {};
    const nextCreds: StoredConnectorCredentials = { ...existingCreds };
    let credsChanged = false;
    if (headers !== undefined) { nextCreds.headers = headers; credsChanged = true; }
    if (input.clientId !== undefined) {
      nextCreds.clientId = typeof input.clientId === "string" && input.clientId.trim() ? input.clientId.trim() : undefined;
      credsChanged = true;
    }
    if (input.clientSecret !== undefined) {
      if (typeof input.clientSecret === "string" && input.clientSecret) nextCreds.clientSecret = input.clientSecret;
      else if (input.clientSecret === null || input.clientSecret === "") delete nextCreds.clientSecret;
      credsChanged = true;
    }
    if (patch.url !== undefined && patch.url !== current.url) {
      delete nextCreds.oauth;
      credsChanged = true;
      patch.status = nextAuth === "oauth" ? "needs_auth" : "disconnected";
      patch.statusDetail = "";
      patch.tools = [];
    }
    if (patch.authKind !== undefined && patch.authKind !== current.authKind) {
      if (patch.authKind !== "oauth") delete nextCreds.oauth;
      if (patch.authKind === "none") delete nextCreds.headers;
      credsChanged = true;
      patch.status = patch.authKind === "oauth" ? "needs_auth" : "disconnected";
      patch.statusDetail = "";
    }
    if (credsChanged) {
      this.store.connectors.saveCredentials(id, nextAuth, nextCreds);
      this.secrets.refreshMask();
    }
    const updated = this.store.connectors.update(id, patch) ?? this.missing();
    if (headers !== undefined && nextAuth === "headers" && Object.keys(headers).length > 0) {
      return this.probe(id).catch(() => this.get(id));
    }
    return updated;
  }

  delete(id: string): void {
    this.oauth.clear(id);
    if (!this.store.connectors.delete(id)) this.missing();
    this.secrets.refreshMask();
  }

  grant(id: string, botId: string, granted: boolean): Connector {
    this.get(id);
    if (!this.store.bots.get(botId)) throw new RuntimeFault("bot_missing", "Bot not found", 404);
    if (granted) this.store.connectors.grant(id, botId); else this.store.connectors.revoke(id, botId);
    return this.get(id);
  }

  uses(id: string): ConnectorUse[] { this.get(id); return this.store.connectors.uses(id); }

  probe(id: string): Promise<Connector> {
    this.get(id);
    return this.withLock(id, () => this.probeLocked(id));
  }

  disconnect(id: string): Connector {
    const current = this.get(id);
    this.oauth.clear(id);
    const creds = this.store.connectors.credentials(id) ?? {};
    const next: StoredConnectorCredentials = {
      ...(creds.clientId ? { clientId: creds.clientId } : {}),
      ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}),
    };
    this.store.connectors.saveCredentials(id, current.authKind, next);
    this.secrets.refreshMask();
    return this.store.connectors.update(id, {
      status: current.authKind === "oauth" ? "needs_auth" : "disconnected",
      statusDetail: "",
      tools: [],
    })!;
  }

  private async probeLocked(id: string): Promise<Connector> {
    const connector = this.get(id);
    const creds = this.store.connectors.credentials(id);
    if (creds === null) {
      return this.store.connectors.update(id, { status: "error", statusDetail: "Credentials cannot be decrypted" })!;
    }
    const result = await this.driver.probe({
      kind: connector.kind,
      provider: connector.provider,
      url: connector.url,
      authKind: connector.authKind,
      headers: creds.headers,
      oauth: creds.oauth,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUrl: this.oauth.defaultRedirectUri(),
    });
    if ("snapshot" in result && result.snapshot) {
      this.store.connectors.saveCredentials(id, connector.authKind, { ...creds, oauth: result.snapshot });
      this.secrets.refreshMask();
    }
    if (result.outcome === "connected") {
      return this.store.connectors.update(id, { status: "connected", statusDetail: result.accountLabel?.slice(0, 120) ?? "", tools: result.tools })!;
    }
    if (result.outcome === "needs_auth") {
      return this.store.connectors.update(id, { status: "needs_auth", statusDetail: result.message.slice(0, 300) })!;
    }
    return this.store.connectors.update(id, { status: "error", statusDetail: result.message.slice(0, 300) })!;
  }

  /** connectors.list: every enabled connector, whether the Bot may use it, its status and tool names. */
  listFor(botId: string) {
    const granted = this.store.connectors.grantedIds(botId);
    const connectors = this.store.connectors.list().filter(c => c.enabled).map(c => ({
      slug: c.slug,
      name: c.name,
      provider: c.provider,
      granted: granted.has(c.id),
      status: c.status,
      safety: c.safety,
      tools: c.tools.map(tool => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description.slice(0, 140) } : {}),
        write: isWriteTool(tool),
      })),
    }));
    const note = !connectors.length
      ? "No connectors configured yet. Ask your owner to add one in Settings → Connectors."
      : connectors.some(c => !c.granted || c.status !== "connected")
        ? "Use connectors.request to ask your owner for access or sign-in when granted=false or status!=connected."
        : undefined;
    return { connectors, ...(note ? { note } : {}) };
  }

  /** connectors.describe: full tool schemas for one granted connector. */
  describeFor(botId: string, slug: string, toolName?: string) {
    const connector = this.requireGranted(botId, slug);
    const tools = toolName
      ? connector.tools.filter(t => t.name === toolName)
      : connector.tools;
    if (toolName && !tools.length) throw new ChatError(404, `Connector "${slug}" has no tool named "${toolName}"`);
    return {
      slug: connector.slug,
      name: connector.name,
      status: connector.status,
      safety: connector.safety,
      tools: tools.map(t => ({
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        ...(t.description ? { description: t.description } : {}),
        write: isWriteTool(t),
        inputSchema: t.inputSchema,
      })),
    };
  }

  /** connectors.call: invokes a tool on a granted connector, enforcing safety policy and masking output. */
  async callFor(
    botId: string,
    chatId: string,
    slug: string,
    toolName: string,
    args: Record<string, unknown>,
    askWriteConfirm: (question: QuestionSpec) => Promise<QuestionResult>,
    hasPerson: () => boolean,
    signal?: AbortSignal,
  ) {
    const connector = this.requireGranted(botId, slug);
    if (connector.status === "needs_auth")
      throw new ChatError(409, `Connector "${slug}" needs authorization. Call connectors.request first.`, "connector_auth_required");
    const tool = connector.tools.find(t => t.name === toolName);
    if (!tool) throw new ChatError(404, `Connector "${slug}" has no tool named "${toolName}". Run connectors.describe first.`);

    const write = isWriteTool(tool);
    if (write && connector.safety === "read_only") {
      this.store.connectors.recordUse({ connectorId: connector.id, slug: connector.slug, botId, toolName, outcome: "denied", detail: "read_only" });
      throw new ChatError(403, `Connector "${slug}" is configured as read-only; "${toolName}" is a write action.`, "connector_read_only");
    }
    let effectiveArgs = args;
    if (write && connector.safety === "confirm_writes") {
      if (!hasPerson()) {
        this.store.connectors.recordUse({ connectorId: connector.id, slug: connector.slug, botId, toolName, outcome: "denied", detail: "no_person" });
        throw new ChatError(400, `Connector "${slug}" requires owner confirmation for "${toolName}", and there is no person in this chat.`);
      }
      const masker = this.secrets.masker();
      const actionLabel = (tool.title?.trim() || humanizeKey(tool.name)).slice(0, 120);
      const fields = buildWriteFields(args, masker);
      const primary = fields.find(f => ["title", "subject", "name", "to", "channel"].includes(f.key))?.value.split("\n")[0]?.slice(0, 80) || actionLabel;
      const result = await askWriteConfirm({
        question: `${connector.name} · ${primary}`,
        options: [
          { label: "Confirm", value: "confirm", style: "primary" },
          { label: "Discard", value: "discard" },
        ],
        multiple: true,
        allowCustom: true,
        connectorWrite: {
          connectorId: connector.id, slug: connector.slug, name: connector.name,
          provider: connector.provider,
          account: connector.status === "connected" && connector.statusDetail ? connector.statusDetail : null,
          toolName: tool.name, actionLabel, fields,
        },
      });
      if (result.status !== "answered" || result.selected[0]?.value !== "confirm") {
        this.store.connectors.recordUse({ connectorId: connector.id, slug: connector.slug, botId, toolName, outcome: "denied", detail: "declined" });
        return { status: "declined", note: "Your owner declined this write action." };
      }
      if (result.custom) {
        try {
          const edited = JSON.parse(result.custom) as Record<string, unknown>;
          if (edited && typeof edited === "object" && !Array.isArray(edited)) {
            const nextArgs: Record<string, unknown> = { ...args };
            for (const [origKey, origVal] of Object.entries(args)) {
              const lower = origKey.trim().toLowerCase();
              if (typeof edited[lower] === "string" && (typeof origVal === "string" || typeof origVal === "number")) {
                nextArgs[origKey] = typeof origVal === "number" ? Number(edited[lower]) : edited[lower];
              }
            }
            if (typeof edited.cc === "string" && edited.cc.trim() && nextArgs.cc === undefined) {
              nextArgs.cc = edited.cc.trim();
            }
            effectiveArgs = nextArgs;
          }
        } catch { /* ignore malformed custom payload */ }
      }
    }

    const res = await this.withLock(connector.id, async () => {
      const creds = this.store.connectors.credentials(connector.id);
      if (creds === null) throw new ChatError(409, `Connector "${slug}" credentials cannot be decrypted`, "credential_unreadable");
      const out = await this.driver.callTool({
        kind: connector.kind,
        provider: connector.provider,
        url: connector.url,
        authKind: connector.authKind,
        headers: creds.headers,
        oauth: creds.oauth,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        redirectUrl: this.oauth.defaultRedirectUri(),
        toolName,
        args: effectiveArgs,
        signal,
      });
      if ("snapshot" in out && out.snapshot) {
        this.store.connectors.saveCredentials(connector.id, connector.authKind, { ...creds, oauth: out.snapshot });
        this.secrets.refreshMask();
      }
      return out;
    });

    if (res.outcome === "needs_auth") {
      this.store.connectors.update(connector.id, { status: "needs_auth", statusDetail: res.message.slice(0, 300) });
      this.store.connectors.recordUse({ connectorId: connector.id, slug: connector.slug, botId, toolName, outcome: "error", detail: "needs_auth" });
      throw new ChatError(409, `Connector "${slug}" authorization expired or missing. Call connectors.request.`, "connector_auth_required");
    }
    if (res.outcome === "error") {
      this.store.connectors.recordUse({ connectorId: connector.id, slug: connector.slug, botId, toolName, outcome: "error", detail: res.message });
      throw new RuntimeFault("connector_unreachable", res.message, 502);
    }

    this.store.connectors.recordUse({
      connectorId: connector.id, slug: connector.slug, botId, toolName,
      outcome: res.isError ? "error" : "ok", detail: res.isError ? res.text.slice(0, 200) : "",
    });
    const masked = this.secrets.masker().mask(res.text);
    const text = masked.length > MAX_TOOL_TEXT
      ? `${masked.slice(0, MAX_TOOL_TEXT)}\n\n[truncated ${masked.length - MAX_TOOL_TEXT} characters; narrow your query]`
      : masked;
    if (res.images.length) return { kind: "media" as const, text: JSON.stringify({ isError: res.isError, text }), images: res.images };
    return { isError: res.isError, text };
  }

  /** connectors.request: returns immediately if granted & connected, else prepares an in-chat auth/grant card. */
  async prepareRequest(botId: string, slug: string, purpose: string): Promise<{ ready: true } | { question: QuestionSpec }> {
    const connector = this.store.connectors.bySlug(slug);
    if (!connector || !connector.enabled) throw new ChatError(404, `No enabled connector named "${slug}" (see connectors.list)`);
    let current = connector;
    if (current.authKind !== "oauth" && current.status === "disconnected") {
      current = await this.probe(current.id);
    }
    const granted = this.store.connectors.grantedIds(botId).has(current.id);
    const needsAuth = current.status !== "connected";
    if (granted && !needsAuth) return { ready: true };
    return {
      question: {
        question: purpose,
        options: [{ label: "Allow", value: "allow", style: "primary" }],
        multiple: false,
        allowCustom: false,
        connectorAuth: {
          connectorId: current.id, slug: current.slug, name: current.name,
          provider: current.provider, purpose, authKind: current.authKind,
          needsGrant: !granted, needsAuth,
        },
      },
    };
  }

  /** Settles an in-chat connectorAuth card once authorized (or already connected) and grants access to the Bot. */
  async fulfilAuth(actorId: string, chatId: string, messageId: string): Promise<ChatMessage> {
    const message = this.chats.message(actorId, messageId);
    const ask = message?.question?.connectorAuth;
    if (!message || message.chatId !== chatId || !ask || message.question?.state !== "pending")
      throw new ChatError(409, "The question is already settled", "question_closed");
    if (!this.chats.questions.waitingFor(messageId))
      throw new ChatError(409, "The question has expired", "question_expired");

    let connector = this.get(ask.connectorId);
    if (connector.status !== "connected") {
      connector = await this.probe(connector.id);
    }
    if (connector.status !== "connected") {
      throw new ChatError(409, connector.statusDetail || "Connector is not connected yet", "connector_auth_required");
    }
    this.store.connectors.grant(connector.id, message.sender.id);
    return this.chats.questions.respond(actorId, chatId, messageId, { action: "answer", selected: [0] });
  }

  private requireGranted(botId: string, slug: string): Connector {
    const connector = this.store.connectors.bySlug(slug);
    if (!connector || !connector.enabled) throw new ChatError(404, `No enabled connector named "${slug}" (see connectors.list)`);
    if (!this.store.connectors.grantedIds(botId).has(connector.id))
      throw new ChatError(403, `Connector "${slug}" is not granted to you. Ask with connectors.request.`, "connector_auth_required");
    return connector;
  }

  private async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }

  private freeSlug(base: string): string {
    const existing = new Set(this.store.connectors.list().map(c => c.slug));
    if (!existing.has(base)) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base}-${n}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  private missing(): never { throw new RuntimeFault("connector_missing", "Connector not found", 404); }
}
