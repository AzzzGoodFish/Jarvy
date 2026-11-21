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
  applyEdits, assertSameAccount, buildWriteConfirmQuestion, cleanHeaders, cleanName, cleanSlug, cleanUrl,
  filterUnconfirmedEntries, formatConnectorDescribe, formatConnectorList, pickConnectorSlug, pickPresetName,
} from "./connectors-format.js";
import { fulfilConnectorAuth, prepareConnectorAuthRequest, type FulfilAuthInput } from "./connectors-requests.js";

const MAX_TOOL_TEXT = 32_000;

/** Connectors service (A102): vendor-agnostic lifecycle, encrypted credentials, per-Bot grants, fingerprinted
 * write confirmations, and usage logs. Vendor specifics live behind `ConnectorDriver` (`infra/connectors/providers/`). */
export class ConnectorService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
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
      id => this.generation(id),
      (provider, snapshot, name) => this.createFromOAuth(provider, snapshot, name),
      () => this.secrets.refreshMask(),
      text => this.secrets.masker().mask(text),
    );
  }

  private generation(id: string): number { return this.generations.get(id) ?? 0; }
  private bumpGeneration(id: string): number { const next = this.generation(id) + 1; this.generations.set(id, next); return next; }

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
    const existing = this.store.connectors.list();
    const accountLabel = probe.accountLabel?.slice(0, 120);
    const slug = pickConnectorSlug(meta.id, new Set(existing.map(c => c.slug)), accountLabel ?? (typeof input.name === "string" ? input.name : undefined));
    const name = pickPresetName(meta.name, input.name, accountLabel, existing.filter(c => c.provider === meta.id).length);
    const created = this.store.connectors.create({
      slug, name, kind: meta.kind, provider: meta.id, url: meta.defaultUrl, authKind: "headers",
      enabled: true, status: "connected", statusDetail: accountLabel ?? "",
      tools: probe.tools, credentials: { headers },
    });
    this.secrets.refreshMask();
    return created;
  }

  private async createFromOAuth(provider: ConnectorProvider, snapshot: McpOAuthSnapshot, requestedName?: string): Promise<Connector> {
    const meta = this.driver.meta(provider);
    const probed = await this.driver.probe({
      provider, url: meta.defaultUrl, authKind: "oauth", oauth: snapshot,
      ...(this.env.isManaged(provider) ? (this.env.client(provider) ?? {}) : {}),
      redirectUrl: this.oauth.defaultRedirectUri(),
    });
    const finalOAuth = "snapshot" in probed && probed.snapshot ? probed.snapshot : snapshot;
    const existing = this.store.connectors.list();
    const accountLabel = probed.outcome === "connected" ? probed.accountLabel?.slice(0, 120) : undefined;
    const slug = pickConnectorSlug(provider, new Set(existing.map(c => c.slug)), accountLabel ?? requestedName);
    const name = pickPresetName(meta.name, requestedName, accountLabel, existing.filter(c => c.provider === provider).length);
    const status = probed.outcome === "connected" ? "connected" : probed.outcome === "needs_auth" ? "needs_auth" : "error";
    const statusDetail = probed.outcome === "connected"
      ? (accountLabel ?? "")
      : this.secrets.masker().mask(probed.message).slice(0, 300);
    const created = this.store.connectors.create({
      slug, name, kind: meta.kind, provider, url: meta.defaultUrl, authKind: "oauth", enabled: true,
      status, statusDetail, tools: probed.outcome === "connected" ? probed.tools : [], credentials: { oauth: finalOAuth },
    });
    this.secrets.refreshMask();
    return created;
  }

  async create(input: {
    slug?: unknown; name?: unknown; provider?: unknown; url?: unknown; authKind?: unknown;
    headers?: unknown; clientId?: unknown; clientSecret?: unknown;
  }): Promise<Connector> {
    const provider: ConnectorProvider = typeof input.provider === "string" && this.driver.hasProvider(input.provider)
      ? input.provider : "custom_mcp";
    const meta = this.driver.meta(provider);
    const slug = input.slug !== undefined && input.slug !== ""
      ? cleanSlug(input.slug)
      : pickConnectorSlug(provider !== "custom_mcp" ? provider : "mcp", new Set(this.store.connectors.list().map(c => c.slug)), typeof input.name === "string" ? input.name : undefined);
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

    if (current.provider !== "custom_mcp" && !urlChanged && credsChanged && nextAuth === "headers") {
      return this.rotatePresetHeaders(id, { name, headers, enabled, unconfirmed: input.unconfirmed });
    }

    if (urlChanged) {
      // Changing a custom MCP destination is a new trust decision: bump generation first so any in-flight
      // probe/call/OAuth discards stale writes, then wipe credentials, cached tools and saved exemptions.
      this.bumpGeneration(id);
      this.oauth.clear(id);
      this.store.connectors.saveCredentials(id, nextAuth, {});
      this.store.connectors.setUnconfirmed(id, []);
      this.secrets.refreshMask();
    } else if (credsChanged) {
      this.bumpGeneration(id);
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
        ? { status: nextAuth === "none" ? "disconnected" : "needs_auth", statusDetail: "", accountLabel: null, tools: [] }
        : authChanged && nextAuth === "oauth" ? { status: "needs_auth", statusDetail: "" } : {}),
    }) ?? this.missing();
    if (!urlChanged && credsChanged && updated.authKind !== "oauth") return this.probe(id).catch(() => this.get(id));
    return updated;
  }

  /** Probes a replacement preset token BEFORE saving so failed probes or another account never touch the existing connection. */
  private rotatePresetHeaders(
    id: string,
    input: { name?: string; headers?: Record<string, string>; enabled?: boolean; unconfirmed?: unknown },
  ): Promise<Connector> {
    return this.withLock(id, async () => {
      const live = this.store.connectors.get(id) ?? this.missing();
      const headers = input.headers ?? {};
      if (Object.keys(headers).length === 0) throw new RuntimeFault("connector_auth_required", "Enter an access token", 400);
      const probed = await this.driver.probe({
        provider: live.provider, url: live.url, authKind: "headers", headers,
        redirectUrl: this.oauth.defaultRedirectUri(),
      });
      if (probed.outcome !== "connected") {
        const msg = this.secrets.masker().mask(probed.message).slice(0, 300);
        throw new RuntimeFault(probed.outcome === "needs_auth" ? "connector_auth_required" : "connector_unreachable", msg, 400);
      }
      assertSameAccount(live.account, probed.accountLabel);
      const label = probed.accountLabel?.trim().slice(0, 120) || live.account;
      this.bumpGeneration(id);
      this.oauth.clear(id);
      this.store.connectors.saveCredentials(id, "headers", { headers });
      this.secrets.refreshMask();
      if (Array.isArray(input.unconfirmed)) {
        this.store.connectors.setUnconfirmed(id, filterUnconfirmedEntries(input.unconfirmed, probed.tools));
      }
      return this.store.connectors.update(id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        authKind: "headers", status: "connected", statusDetail: label,
        ...(label ? { accountLabel: label } : {}),
        tools: probed.tools,
      }) ?? this.missing();
    });
  }

  delete(id: string): void {
    this.bumpGeneration(id);
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
    this.bumpGeneration(id);
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
    const startGen = this.generation(id);
    const connector = this.store.connectors.get(id);
    if (!connector) this.missing();
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
    // Discard stale probe results if settings/disconnect/delete ran while awaiting the remote server.
    if (this.generation(id) !== startGen) return this.store.connectors.get(id) ?? connector;
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
    return formatConnectorList(this.store.connectors.list(), this.store.connectors.grantedTo(botId), query);
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
      const startGen = this.generation(live!.id);
      if (confirmed?.always) this.store.connectors.allowUnconfirmed(live!.id, liveTool!.name, confirmed.toolHash);
      const out = await this.driver.callTool({
        provider: live!.provider, url: live!.url, authKind: live!.authKind,
        headers: creds.headers, oauth: creds.oauth, ...this.clientOf(live!, creds),
        redirectUrl: this.oauth.defaultRedirectUri(), toolName, args: finalArgs, signal,
      });
      // Discard refreshed token snapshots if settings/disconnect/delete ran while this tool call was in flight.
      if ("snapshot" in out && out.snapshot && this.generation(live!.id) === startGen) {
        this.store.connectors.saveCredentials(live!.id, live!.authKind, { ...creds, oauth: out.snapshot });
        this.secrets.refreshMask();
      }
      return { out, stale: this.generation(live!.id) !== startGen };
    });

    const { out, stale } = res;
    if (out.outcome === "needs_auth") {
      const masked = this.secrets.masker().mask(out.message);
      if (!stale) this.store.connectors.update(initial.id, { status: "needs_auth", statusDetail: masked.slice(0, 300) });
      this.store.connectors.recordUse({ connectorId: initial.id, slug: initial.slug, botId, toolName, outcome: "error", detail: masked });
      throw new ChatError(409, `Connector "${slug}" needs re-authorization (${masked}). Ask your owner with connectors.request.`, "connector_auth_required");
    }
    if (out.outcome === "error") {
      const masked = this.secrets.masker().mask(out.message);
      this.store.connectors.recordUse({ connectorId: initial.id, slug: initial.slug, botId, toolName, outcome: "error", detail: masked });
      throw new ChatError(409, `Connector "${slug}" failed: ${masked}`, "connector_unreachable");
    }
    const maskedText = this.secrets.masker().mask(out.text);
    const text = maskedText.length > MAX_TOOL_TEXT ? `${maskedText.slice(0, MAX_TOOL_TEXT)}\n…(truncated)` : maskedText;
    this.store.connectors.recordUse({
      connectorId: initial.id, slug: initial.slug, botId, toolName,
      outcome: out.isError ? "error" : "ok", detail: out.isError ? text.slice(0, 200) : "",
    });
    return { connector: slug, tool: toolName, isError: out.isError, text };
  }

  private authRequestDeps() {
    return {
      store: this.store, chats: this.chats, driver: this.driver, env: this.env,
      withLock: <T>(id: string, work: () => Promise<T>) => this.withLock(id, work),
      probe: (id: string) => this.probe(id),
      probeLocked: (id: string) => this.probeLocked(id),
    };
  }

  /** connectors.request: returns immediately if granted & connected, else prepares an in-chat auth/grant card. */
  prepareRequest(botId: string, slug: string, purpose: string): Promise<{ ready: true } | { question: QuestionSpec }> {
    return prepareConnectorAuthRequest(this.authRequestDeps(), botId, slug, purpose);
  }

  /** Settles an in-chat connectorAuth card after verifying displayed account, credentials and requesting run. */
  fulfilAuth(actorId: string, chatId: string, messageId: string, input?: FulfilAuthInput): Promise<ChatMessage> {
    return fulfilConnectorAuth(this.authRequestDeps(), actorId, chatId, messageId, input);
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

  private clientOf(connector: Connector, creds: StoredConnectorCredentials): { clientId?: string; clientSecret?: string } {
    if (this.env.isManaged(connector.provider)) return this.env.client(connector.provider) ?? {};
    return { ...(creds.clientId ? { clientId: creds.clientId } : {}), ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}) };
  }

  publicUrl(): string | null { return this.env.publicUrl(); }

  private missing(): never { throw new RuntimeFault("connector_missing", "Connector not found", 404); }
}
