import type {
  Connector, ConnectorAuthKind, ConnectorPreset, ConnectorProvider, ConnectorUse,
} from "../../contract/connectors.js";
import type { QuestionSpec } from "../../contract/chat.js";
import type { ChatMessage } from "../shared/chat.js";
import {
  isWriteTool, toolDefinitionHash,
  type ConnectorDriver, type McpOAuthSnapshot, type StoredConnectorCredentials,
} from "../shared/connector.js";
import type { Store } from "../infra/storage/store.js";
import { ChatError } from "../shared/chat.js";
import { ValidationError } from "../shared/errors.js";
import { RuntimeFault } from "../shared/runtime.js";
import type { ChatService } from "./chat/service.js";
import type { SecretService } from "./secrets.js";
import type { Listening } from "./connection.js";
import type { QuestionResult } from "./chat/questions.js";
import { ConnectorOAuthCoordinator } from "./connectors-oauth.js";
import type { ConnectorEnv } from "../infra/connectors/client-env.js";
import {
  applyEdits, buildWriteConfirmQuestion, cleanHeaders, cleanName, cleanSlug, cleanUrl,
  filterUnconfirmedEntries, formatConnectorDescribe, formatConnectorList,
} from "./connectors-format.js";

const MAX_TOOL_TEXT = 32_000;

/** Connectors service (A99): vendor-agnostic lifecycle, encrypted credentials, per-Bot grants, fingerprinted
 * write confirmations, and usage logs. Vendor specifics live behind `ConnectorDriver` (`infra/connectors/providers/`). */
export class ConnectorService {
  private readonly locks = new Map<string, Promise<unknown>>();
  readonly oauth: ConnectorOAuthCoordinator;

  constructor(
    private readonly store: Store,
    private readonly chats: ChatService,
    private readonly secrets: SecretService,
    private readonly driver: ConnectorDriver,
    listening: () => Listening | null,
    private readonly env: ConnectorEnv,
  ) {
    this.oauth = new ConnectorOAuthCoordinator(
      store, driver, listening, env,
      (id, work) => this.withLock(id, work),
      id => this.probeLocked(id).then(() => {}),
      (provider, snapshot) => this.createFromOAuth(provider, snapshot),
      () => this.secrets.refreshMask(),
      text => this.secrets.masker().mask(text),
    );
  }

  presets(): ConnectorPreset[] {
    return this.driver.catalog().map(item => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      url: item.defaultUrl,
      authMethods: [...item.authMethods],
      managedClient: this.env.managedInfo(item.id),
    }));
  }

  list(): Connector[] { return this.store.connectors.list(); }

  get(id: string): Connector { return this.store.connectors.get(id) ?? this.missing(); }

  /** Connects a preset using a personal access token, probing BEFORE persisting so invalid tokens never leave orphan rows. */
  async connectToken(input: { provider: unknown; token: unknown; name?: unknown }): Promise<Connector> {
    if (typeof input.provider !== "string" || !this.driver.hasProvider(input.provider) || input.provider === "custom_mcp")
      throw new RuntimeFault("connector_missing", "Unknown connector preset", 404);
    const meta = this.driver.meta(input.provider);
    if (!meta.authMethods.includes("headers"))
      throw new RuntimeFault("connector_auth_required", `${meta.name} only supports web sign-in`, 400);
    const rawToken = typeof input.token === "string" ? input.token.trim() : "";
    if (!rawToken) throw new RuntimeFault("connector_auth_required", "Enter an access token", 400);
    const headers = { Authorization: /^Bearer\s+/i.test(rawToken) ? rawToken : `Bearer ${rawToken}` };
    const probe = await this.driver.probe({
      provider: meta.id,
      url: meta.defaultUrl,
      authKind: "headers",
      headers,
      redirectUrl: this.oauth.defaultRedirectUri(),
    });
    if (probe.outcome !== "connected") {
      const msg = this.secrets.masker().mask(probe.message).slice(0, 300);
      throw new RuntimeFault(probe.outcome === "needs_auth" ? "connector_auth_required" : "connector_unreachable", msg, 400);
    }
    const slug = this.freeSlug(meta.id);
    const name = cleanName(input.name, meta.name);
    const created = this.store.connectors.create({
      slug, name, kind: meta.kind, provider: meta.id, url: meta.defaultUrl, authKind: "headers",
      enabled: true, status: "connected", statusDetail: probe.accountLabel?.slice(0, 120) ?? "",
      tools: probe.tools, credentials: { headers },
    });
    this.secrets.refreshMask();
    return created;
  }

  private async createFromOAuth(provider: ConnectorProvider, snapshot: McpOAuthSnapshot): Promise<Connector> {
    const meta = this.driver.meta(provider);
    const slug = this.freeSlug(provider);
    const created = this.store.connectors.create({
      slug, name: meta.name, kind: meta.kind, provider, url: meta.defaultUrl, authKind: "oauth",
      enabled: true, status: "needs_auth", credentials: { oauth: snapshot },
    });
    this.secrets.refreshMask();
    return this.probeLocked(created.id);
  }

  async create(input: {
    slug?: unknown; name?: unknown; provider?: unknown; url?: unknown; authKind?: unknown;
    headers?: unknown; clientId?: unknown; clientSecret?: unknown;
  }): Promise<Connector> {
    const provider: ConnectorProvider = typeof input.provider === "string" && this.driver.hasProvider(input.provider)
      ? input.provider : "custom_mcp";
    const meta = this.driver.meta(provider);
    const slug = input.slug !== undefined && input.slug !== ""
      ? cleanSlug(input.slug) : this.freeSlug(provider !== "custom_mcp" ? provider : "mcp");
    const name = cleanName(input.name, meta.name || slug);
    const url = cleanUrl(provider !== "custom_mcp" ? meta.defaultUrl : (input.url ?? meta.defaultUrl));
    const requestedAuth = typeof input.authKind === "string" && meta.authMethods.includes(input.authKind as ConnectorAuthKind)
      ? (input.authKind as ConnectorAuthKind) : undefined;
    const authKind: ConnectorAuthKind = requestedAuth
      ?? (meta.authMethods.includes("oauth") && (!this.env.isManaged(provider) || this.env.client(provider))
        ? "oauth" : meta.authMethods[0]!);
    const headers = cleanHeaders(input.headers);
    const own = !this.env.isManaged(provider);
    const clientId = own && typeof input.clientId === "string" && input.clientId.trim() ? input.clientId.trim() : undefined;
    const clientSecret = own && typeof input.clientSecret === "string" && input.clientSecret.trim() ? input.clientSecret.trim() : undefined;
    const credentials: StoredConnectorCredentials = {
      ...(headers && Object.keys(headers).length ? { headers } : {}),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    };
    const created = this.store.connectors.create({
      slug, name, kind: meta.kind, provider, url, authKind,
      enabled: true, status: authKind === "oauth" ? "needs_auth" : "disconnected", credentials,
    });
    this.secrets.refreshMask();
    if (authKind !== "oauth") return this.probe(created.id).catch(() => this.get(created.id));
    return created;
  }

  async update(id: string, input: {
    name?: unknown; url?: unknown; authKind?: unknown;
    headers?: unknown; clientId?: unknown; clientSecret?: unknown; unconfirmed?: unknown; enabled?: unknown;
  }): Promise<Connector> {
    const current = this.get(id);
    const meta = this.driver.meta(current.provider);
    const name = input.name !== undefined ? cleanName(input.name, current.name) : undefined;
    const requestedUrl = input.url !== undefined ? cleanUrl(input.url) : undefined;
    if (current.provider !== "custom_mcp" && requestedUrl !== undefined && requestedUrl !== current.url) {
      throw new ValidationError("Preset connector endpoint cannot be changed", "connector_url_invalid");
    }
    const url = current.provider === "custom_mcp" ? requestedUrl : undefined;
    const urlChanged = url !== undefined && url !== current.url;
    const authKind: ConnectorAuthKind | undefined = typeof input.authKind === "string" && meta.authMethods.includes(input.authKind as ConnectorAuthKind)
      ? (input.authKind as ConnectorAuthKind) : undefined;
    const authChanged = authKind !== undefined && authKind !== current.authKind;
    const nextAuth = authKind ?? current.authKind;
    const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;
    const headers = input.headers !== undefined ? cleanHeaders(input.headers) : undefined;
    const own = !this.env.isManaged(current.provider);
    const credsChanged = urlChanged || authChanged || headers !== undefined || (own && (input.clientId !== undefined || input.clientSecret !== undefined));

    if (urlChanged) {
      // Changing a custom MCP destination is a new trust decision: discard credentials, pending OAuth,
      // cached tools and saved write exemptions, and require reconnection before authenticated use.
      this.oauth.clear(id);
      this.store.connectors.saveCredentials(id, nextAuth, {});
      this.store.connectors.setUnconfirmed(id, []);
      this.secrets.refreshMask();
    } else if (credsChanged) {
      const prior = this.store.connectors.credentials(id) ?? {};
      const next: StoredConnectorCredentials = { ...prior };
      if (authChanged) {
        if (nextAuth !== "headers") delete next.headers;
        if (nextAuth !== "oauth") { delete next.oauth; this.oauth.clear(id); }
      }
      if (headers !== undefined && nextAuth === "headers") next.headers = headers;
      if (own && input.clientId !== undefined) {
        if (typeof input.clientId === "string" && input.clientId.trim()) next.clientId = input.clientId.trim();
        else delete next.clientId;
      }
      if (own && input.clientSecret !== undefined) {
        if (typeof input.clientSecret === "string" && input.clientSecret.trim()) next.clientSecret = input.clientSecret.trim();
        else delete next.clientSecret;
      }
      this.store.connectors.saveCredentials(id, nextAuth, next);
      this.secrets.refreshMask();
    }

    if (!urlChanged && Array.isArray(input.unconfirmed)) {
      this.store.connectors.setUnconfirmed(id, filterUnconfirmedEntries(input.unconfirmed, current.tools));
    }

    const updated = this.store.connectors.update(id, {
      ...(name !== undefined ? { name } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(authKind !== undefined ? { authKind } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(urlChanged
        ? { status: nextAuth === "none" ? "disconnected" : "needs_auth", statusDetail: "", tools: [] }
        : authChanged && nextAuth === "oauth" ? { status: "needs_auth", statusDetail: "" } : {}),
    }) ?? this.missing();
    if (!urlChanged && credsChanged && updated.authKind !== "oauth") return this.probe(id).catch(() => this.get(id));
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
    if (creds === null) return this.store.connectors.update(id, { status: "error", statusDetail: "Credentials cannot be decrypted" })!;
    if (connector.authKind === "headers" && Object.keys(creds.headers ?? {}).length === 0) {
      return this.store.connectors.update(id, { status: "needs_auth", statusDetail: "Authentication credentials required", tools: [] })!;
    }
    const result = await this.driver.probe({
      provider: connector.provider,
      url: connector.url,
      authKind: connector.authKind,
      headers: creds.headers,
      oauth: creds.oauth,
      ...this.clientOf(connector, creds),
      redirectUrl: this.oauth.defaultRedirectUri(),
    });
    if ("snapshot" in result && result.snapshot) {
      this.store.connectors.saveCredentials(id, connector.authKind, { ...creds, oauth: result.snapshot });
      this.secrets.refreshMask();
    }
    if (result.outcome === "connected") {
      return this.store.connectors.update(id, { status: "connected", statusDetail: result.accountLabel?.slice(0, 120) ?? "", tools: result.tools })!;
    }
    const detail = this.secrets.masker().mask(result.message).slice(0, 300);
    return this.store.connectors.update(id, { status: result.outcome === "needs_auth" ? "needs_auth" : "error", statusDetail: detail })!;
  }

  /** connectors.list: compact summary when a connector exposes many tools; supports optional keyword filtering. */
  listFor(botId: string, query?: string) {
    return formatConnectorList(this.store.connectors.list(), this.store.connectors.grantedIds(botId), query);
  }

  /** connectors.describe: full tool schemas for one granted connector, filterable by exact tool name or keyword query. */
  describeFor(botId: string, slug: string, toolName?: string, query?: string) {
    return formatConnectorDescribe(this.requireGranted(botId, slug), toolName, query);
  }

  /** connectors.call: invokes a tool on a granted connector; write tools ask on a card unless fingerprinted as unconfirmed. */
  async callTool(
    botId: string, chatId: string, slug: string, toolName: string, args: Record<string, unknown>,
    ask: (question: QuestionSpec) => Promise<QuestionResult & { messageId: string }>,
    hasPerson: () => boolean, signal?: AbortSignal,
  ) {
    const initial = this.requireGranted(botId, slug);
    if (initial.status !== "connected") {
      throw new ChatError(409, `Connector "${slug}" is not connected (status: ${initial.status}). Ask your owner with connectors.request.`, "connector_auth_required");
    }
    const initialTool = initial.tools.find(item => item.name === toolName);
    if (!initialTool) throw new ChatError(404, `Connector "${slug}" has no tool named "${toolName}" (check connectors.describe)`);

    let confirmed: {
      messageId: string; always: boolean; custom: string | null; editableKeys: ReadonlySet<string>;
      url: string; authKind: ConnectorAuthKind; account: string; credFp: string; toolHash: string;
    } | null = null;

    if (isWriteTool(initialTool) && !this.store.connectors.isUnconfirmed(initial.id, initialTool)) {
      if (!hasPerson()) {
        this.store.connectors.recordUse({ connectorId: initial.id, slug: initial.slug, botId, toolName, outcome: "denied", detail: "no person to confirm write" });
        throw new ChatError(409, `"${toolName}" on "${slug}" asks the owner before running, and no person is in this chat. Ask them in a chat with them, or they can turn confirmation off for this tool in Settings → Connectors.`);
      }
      const binding = {
        url: initial.url, authKind: initial.authKind, account: initial.statusDetail,
        credFp: this.store.connectors.credentialFingerprint(initial.id), toolHash: toolDefinitionHash(initialTool),
      };
      const { question, editableKeys } = buildWriteConfirmQuestion(initial, initialTool, args, this.secrets.masker());
      const result = await ask(question);
      const picked = result.status === "answered" ? result.selected[0]?.value : undefined;
      if (picked !== "confirm" && picked !== "confirm_always") {
        this.store.connectors.recordUse({ connectorId: initial.id, slug: initial.slug, botId, toolName, outcome: "denied", detail: "declined" });
        return { connector: slug, tool: toolName, status: "declined", note: "Your owner declined this write action." };
      }
      confirmed = { ...binding, messageId: result.messageId, always: picked === "confirm_always", custom: result.status === "answered" ? result.custom : null, editableKeys };
    }

    const res = await this.withLock(initial.id, async () => {
      // Revalidate live authorization, destination, account/credentials and tool definition inside the lock.
      const live = this.store.connectors.get(initial.id);
      const liveTool = live?.tools.find(item => item.name === toolName);
      const granted = Boolean(live && this.store.connectors.grantedIds(botId).has(live.id));
      const liveValid = Boolean(live && live.enabled && live.status === "connected" && granted && liveTool);
      const bindingValid = !confirmed || (
        liveValid
        && live!.url === confirmed.url
        && live!.authKind === confirmed.authKind
        && live!.statusDetail === confirmed.account
        && this.store.connectors.credentialFingerprint(live!.id) === confirmed.credFp
        && toolDefinitionHash(liveTool!) === confirmed.toolHash
      );
      if (!liveValid || !bindingValid) {
        if (confirmed) this.chats.questions.invalidate(chatId, confirmed.messageId);
        this.store.connectors.recordUse({ connectorId: initial.id, slug: initial.slug, botId, toolName, outcome: "denied", detail: "confirmation expired: connector changed" });
        throw new ChatError(409, `Confirmation for "${toolName}" on "${slug}" expired because connector access, settings, account or tool definition changed. Check connectors.list and ask again if still needed.`, "question_expired");
      }
      if (!confirmed && isWriteTool(liveTool!) && !this.store.connectors.isUnconfirmed(live!.id, liveTool!)) {
        throw new ChatError(409, `"${toolName}" on "${slug}" now requires owner confirmation. Call connectors.call again.`, "question_expired");
      }
      let finalArgs = args;
      if (confirmed?.custom) {
        try { finalArgs = applyEdits(args, confirmed.custom, liveTool!.inputSchema, confirmed.editableKeys); }
        catch (err) { this.chats.questions.invalidate(chatId, confirmed.messageId); throw err; }
      }
      const creds = this.store.connectors.credentials(live!.id);
      if (creds === null) {
        if (confirmed) this.chats.questions.invalidate(chatId, confirmed.messageId);
        throw new ChatError(409, "Connector credentials cannot be decrypted", "credential_unreadable");
      }
      if (confirmed?.always) this.store.connectors.allowUnconfirmed(live!.id, liveTool!.name, confirmed.toolHash);
      const out = await this.driver.callTool({
        provider: live!.provider, url: live!.url, authKind: live!.authKind,
        headers: creds.headers, oauth: creds.oauth, ...this.clientOf(live!, creds),
        redirectUrl: this.oauth.defaultRedirectUri(), toolName, args: finalArgs, signal,
      });
      if ("snapshot" in out && out.snapshot) {
        this.store.connectors.saveCredentials(live!.id, live!.authKind, { ...creds, oauth: out.snapshot });
        this.secrets.refreshMask();
      }
      return out;
    });

    if (res.outcome === "needs_auth") {
      const masked = this.secrets.masker().mask(res.message);
      this.store.connectors.update(initial.id, { status: "needs_auth", statusDetail: masked.slice(0, 300) });
      this.store.connectors.recordUse({ connectorId: initial.id, slug: initial.slug, botId, toolName, outcome: "error", detail: masked });
      throw new ChatError(409, `Connector "${slug}" needs re-authorization (${masked}). Ask your owner with connectors.request.`, "connector_auth_required");
    }
    if (res.outcome === "error") {
      const masked = this.secrets.masker().mask(res.message);
      this.store.connectors.recordUse({ connectorId: initial.id, slug: initial.slug, botId, toolName, outcome: "error", detail: masked });
      throw new ChatError(409, `Connector "${slug}" failed: ${masked}`, "connector_unreachable");
    }
    const maskedText = this.secrets.masker().mask(res.text);
    const text = maskedText.length > MAX_TOOL_TEXT ? `${maskedText.slice(0, MAX_TOOL_TEXT)}\n…(truncated)` : maskedText;
    this.store.connectors.recordUse({
      connectorId: initial.id, slug: initial.slug, botId, toolName,
      outcome: res.isError ? "error" : "ok", detail: res.isError ? text.slice(0, 200) : "",
    });
    return { connector: slug, tool: toolName, isError: res.isError, text };
  }

  /** connectors.request: returns immediately if granted & connected, else prepares an in-chat auth/grant card. */
  async prepareRequest(botId: string, slug: string, purpose: string): Promise<{ ready: true } | { question: QuestionSpec }> {
    const connector = this.store.connectors.bySlug(slug);
    if (!connector || !connector.enabled) throw new ChatError(404, `No enabled connector named "${slug}" (see connectors.list)`);
    let current = connector;
    if (current.authKind !== "oauth" && current.status === "disconnected") current = await this.probe(current.id);
    const granted = this.store.connectors.grantedIds(botId).has(current.id);
    const needsAuth = current.status !== "connected";
    if (granted && !needsAuth) return { ready: true };
    if (needsAuth && current.authKind === "oauth" && this.env.isManaged(current.provider) && !this.env.client(current.provider)) {
      const variables = this.env.variables(current.provider).join(" and ");
      const meta = this.driver.meta(current.provider);
      throw new ChatError(409, meta.authMethods.includes("headers")
        ? `Connector "${slug}" is not connected. The owner connects it in Settings → Connectors with a token, or sets ${variables} for Jarvy to sign in on the web. Tell them.`
        : `Connector "${slug}" can't sign in yet: the owner has to set ${variables} for Jarvy and restart it. Tell them.`, "connector_client_missing");
    }
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

  /** Settles an in-chat connectorAuth card once authorized and grants access to the Bot. */
  async fulfilAuth(actorId: string, chatId: string, messageId: string): Promise<ChatMessage> {
    const message = this.chats.message(actorId, messageId);
    const ask = message?.question?.connectorAuth;
    if (!message || message.chatId !== chatId || !ask || message.question?.state !== "pending")
      throw new ChatError(409, "The question is already settled", "question_closed");
    if (!this.chats.questions.waitingFor(messageId))
      throw new ChatError(409, "The question has expired", "question_expired");

    let connector = this.get(ask.connectorId);
    if (connector.status !== "connected") connector = await this.probe(connector.id);
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

  private clientOf(connector: Connector, creds: StoredConnectorCredentials): { clientId?: string; clientSecret?: string } {
    if (this.env.isManaged(connector.provider)) return this.env.client(connector.provider) ?? {};
    return { ...(creds.clientId ? { clientId: creds.clientId } : {}), ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}) };
  }

  publicUrl(): string | null { return this.env.publicUrl(); }

  private missing(): never { throw new RuntimeFault("connector_missing", "Connector not found", 404); }
}
