import { McpAuthRequiredError, McpClient, McpHttpError, StreamableHttpTransport, toLlmContent, type Tool } from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider, authorizeMcp, McpOAuthAuthorizationRequiredError, McpOAuthProvider,
  type McpOAuthState, type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";
import type { ConnectorKind, ConnectorProvider, ConnectorTool } from "../../../contract/connectors.js";
import type { McpCallResult, McpDriver, McpOAuthSnapshot, McpProbeResult, McpStartOAuthResult } from "../../shared/connector.js";
import { callBuiltinTool, completeBuiltinOAuth, probeBuiltin, startBuiltinOAuth } from "../connectors/builtin.js";

const PROBE_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;

class SnapshotOAuthStore implements McpOAuthStateStore {
  private current: McpOAuthState | undefined;
  private modified = false;
  constructor(initial?: McpOAuthSnapshot) {
    if (initial) this.current = structuredClone(initial) as unknown as McpOAuthState;
  }
  load(): McpOAuthState | undefined { return this.current ? structuredClone(this.current) : undefined; }
  save(state: McpOAuthState): void { this.current = structuredClone(state); this.modified = true; }
  snapshot(): McpOAuthSnapshot | undefined {
    return this.modified && this.current ? (structuredClone(this.current) as unknown as McpOAuthSnapshot) : undefined;
  }
  latest(fallbackUrl: string): McpOAuthSnapshot {
    return (this.current ? structuredClone(this.current) : { serverUrl: fallbackUrl }) as unknown as McpOAuthSnapshot;
  }
}

function mapTool(tool: Tool): ConnectorTool {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? (tool.inputSchema as Record<string, unknown>) : { type: "object", properties: {} };
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: { type: "object", properties: {}, ...schema },
    ...(tool.annotations?.readOnlyHint !== undefined ? { readOnly: tool.annotations.readOnlyHint } : {}),
    ...(tool.annotations?.destructiveHint !== undefined ? { destructive: tool.annotations.destructiveHint } : {}),
  };
}

function isAuthError(error: unknown): boolean {
  if (error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError) return true;
  if (error instanceof McpHttpError && error.status === 401) return true;
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function createOAuthProvider(options: {
  url: string; redirectUrl: string; store: SnapshotOAuthStore;
  clientId?: string; clientSecret?: string; onRedirect?: (url: string) => void;
}) {
  return new McpOAuthProvider({
    serverUrl: options.url,
    redirectUrl: options.redirectUrl,
    clientMetadata: {
      client_name: "Jarvy",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: options.clientSecret ? "client_secret_post" : "none",
    },
    ...(options.clientId ? { clientId: options.clientId } : {}),
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    store: options.store,
    onRedirect: url => { options.onRedirect?.(url.toString()); },
  });
}

function createTransport(options: {
  url: string; authKind: string; headers?: Record<string, string>;
  oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string; redirectUrl: string;
}) {
  const store = new SnapshotOAuthStore(options.oauth);
  const authProvider = options.authKind === "oauth"
    ? adaptOAuthProvider(createOAuthProvider({
        url: options.url, redirectUrl: options.redirectUrl, store,
        clientId: options.clientId, clientSecret: options.clientSecret,
      }))
    : undefined;
  const transport = new StreamableHttpTransport({
    url: options.url,
    ...(options.headers && Object.keys(options.headers).length ? { headers: options.headers } : {}),
    ...(authProvider ? { authProvider } : {}),
  });
  return { transport, store };
}

/** Remote HTTP MCP driver (Driver A) and built-in SaaS adapter router (Driver C) (A94). */
export class PiMcpDriver implements McpDriver {
  async probe(options: {
    kind?: ConnectorKind; provider?: ConnectorProvider;
    url: string; authKind: "none" | "headers" | "oauth"; headers?: Record<string, string>;
    oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string; redirectUrl: string;
  }): Promise<McpProbeResult> {
    if (options.kind === "builtin" && options.provider) {
      return probeBuiltin({ ...options, provider: options.provider });
    }
    const { transport, store } = createTransport(options);
    const client = new McpClient({ name: "Jarvy", version: "1.0.0", requestTimeoutMs: PROBE_TIMEOUT_MS });
    try {
      await client.connect(transport);
      const tools = (await client.listTools({ timeoutMs: PROBE_TIMEOUT_MS })).map(mapTool);
      const snapshot = store.snapshot();
      return { outcome: "connected", tools, ...(snapshot ? { snapshot } : {}) };
    } catch (error) {
      const snapshot = store.snapshot();
      if (isAuthError(error)) return { outcome: "needs_auth", message: errorMessage(error), ...(snapshot ? { snapshot } : {}) };
      return { outcome: "error", message: errorMessage(error) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  async callTool(options: {
    kind?: ConnectorKind; provider?: ConnectorProvider;
    url: string; authKind: "none" | "headers" | "oauth"; headers?: Record<string, string>;
    oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string; redirectUrl: string;
    toolName: string; args: Record<string, unknown>; signal?: AbortSignal;
  }): Promise<McpCallResult> {
    if (options.kind === "builtin" && options.provider) {
      return callBuiltinTool({ ...options, provider: options.provider });
    }
    const { transport, store } = createTransport(options);
    const client = new McpClient({ name: "Jarvy", version: "1.0.0", requestTimeoutMs: CALL_TIMEOUT_MS });
    try {
      await client.connect(transport);
      const result = await client.callTool(options.toolName, options.args, { signal: options.signal, timeoutMs: CALL_TIMEOUT_MS });
      const blocks = toLlmContent(result);
      const texts: string[] = [];
      const images: { data: string; mimeType: string }[] = [];
      for (const block of blocks) {
        if (block.type === "text") texts.push(block.text);
        else if (block.type === "image") images.push({ data: block.data, mimeType: block.mimeType });
      }
      const snapshot = store.snapshot();
      return {
        outcome: "ok",
        text: texts.join("\n") || (result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : ""),
        images,
        isError: result.isError === true,
        ...(snapshot ? { snapshot } : {}),
      };
    } catch (error) {
      const snapshot = store.snapshot();
      if (isAuthError(error)) return { outcome: "needs_auth", message: errorMessage(error), ...(snapshot ? { snapshot } : {}) };
      return { outcome: "error", message: errorMessage(error) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  async startOAuth(options: {
    kind?: ConnectorKind; provider?: ConnectorProvider;
    url: string; oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string; redirectUrl: string; signal?: AbortSignal;
  }): Promise<McpStartOAuthResult> {
    if (options.kind === "builtin" && options.provider) {
      return startBuiltinOAuth({ ...options, provider: options.provider });
    }
    const store = new SnapshotOAuthStore(options.oauth);
    let authUrl = "";
    const provider = createOAuthProvider({
      url: options.url, redirectUrl: options.redirectUrl, store,
      clientId: options.clientId, clientSecret: options.clientSecret,
      onRedirect: url => { authUrl = url; },
    });
    const outcome = await authorizeMcp(provider, { serverUrl: options.url, signal: options.signal });
    if (outcome === "AUTHORIZED") return { outcome: "authorized", snapshot: store.latest(options.url) };
    if (!authUrl) throw new Error("OAuth server did not provide an authorization URL");
    return { outcome: "redirect", authUrl, state: await provider.state(), snapshot: store.latest(options.url) };
  }

  async completeOAuth(options: {
    kind?: ConnectorKind; provider?: ConnectorProvider;
    url: string; oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string; redirectUrl: string;
    code: string; iss?: string; signal?: AbortSignal;
  }): Promise<McpOAuthSnapshot> {
    if (options.kind === "builtin" && options.provider) {
      return completeBuiltinOAuth({ ...options, provider: options.provider });
    }
    const store = new SnapshotOAuthStore(options.oauth);
    const provider = createOAuthProvider({
      url: options.url, redirectUrl: options.redirectUrl, store,
      clientId: options.clientId, clientSecret: options.clientSecret,
    });
    await authorizeMcp(provider, {
      serverUrl: options.url,
      authorizationCode: options.code,
      ...(options.iss ? { iss: options.iss } : {}),
      signal: options.signal,
    });
    return store.latest(options.url);
  }
}
