import { randomBytes } from "node:crypto";
import type {
  ConnectorCallResult, ConnectorProbeResult, ConnectorStartOAuthResult, McpOAuthSnapshot,
} from "../../../shared/connector.js";
import type { RemoteMcpTransport } from "../../pi/mcp.js";
import type {
  AdapterCallInput, AdapterCompleteOAuthInput, AdapterProbeInput, AdapterStartOAuthInput, ConnectorAdapter,
} from "../adapter.js";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
const GITHUB_API_URL = "https://api.github.com";

const trimSlash = (url: string) => url.replace(/\/+$/, "");

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch { return false; }
}

function resolveMcpUrl(raw: string): string {
  const clean = raw.trim();
  if (!clean || trimSlash(clean) === GITHUB_API_URL) return GITHUB_MCP_URL;
  return clean;
}

function resolveBearer(headers?: Record<string, string>, oauth?: McpOAuthSnapshot): string | null {
  if (oauth?.tokens?.access_token) return oauth.tokens.access_token;
  const raw = headers?.Authorization ?? headers?.authorization;
  return raw ? raw.replace(/^Bearer\s+/i, "").trim() || null : null;
}

async function fetchAccountLabel(token: string, url: string): Promise<string | undefined> {
  if (isLocalUrl(url)) return undefined;
  try {
    const res = await fetch(`${GITHUB_API_URL}/user`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Jarvy-Connector" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { login?: unknown };
    return typeof data.login === "string" && data.login ? `@${data.login}` : undefined;
  } catch {
    return undefined;
  }
}

async function startOAuth(input: AdapterStartOAuthInput): Promise<ConnectorStartOAuthResult> {
  if (!input.clientId?.trim()) throw new Error("GitHub OAuth requires a Client ID");
  const state = randomBytes(16).toString("hex");
  const authBase = isLocalUrl(input.url) ? `${trimSlash(input.url)}/login/oauth/authorize` : "https://github.com/login/oauth/authorize";
  const authUrl = new URL(authBase);
  authUrl.searchParams.set("client_id", input.clientId.trim());
  authUrl.searchParams.set("redirect_uri", input.redirectUrl);
  authUrl.searchParams.set("scope", "repo read:user");
  authUrl.searchParams.set("state", state);
  return { outcome: "redirect", authUrl: authUrl.toString(), state, snapshot: { serverUrl: input.url, oauthState: state } };
}

async function completeOAuth(input: AdapterCompleteOAuthInput): Promise<McpOAuthSnapshot> {
  if (!input.clientId?.trim() || !input.clientSecret?.trim()) throw new Error("GitHub OAuth requires both Client ID and Client Secret");
  const tokenUrl = isLocalUrl(input.url) ? `${trimSlash(input.url)}/login/oauth/access_token` : "https://github.com/login/oauth/access_token";
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: input.clientId.trim(),
      client_secret: input.clientSecret.trim(),
      code: input.code,
      redirect_uri: input.redirectUrl,
    }),
    signal: input.signal,
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(String(data.error_description ?? data.error ?? `GitHub token exchange failed (${res.status})`));
  }
  return {
    serverUrl: input.url,
    tokens: {
      access_token: data.access_token,
      token_type: String(data.token_type ?? "bearer"),
      ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
    },
  };
}

/** GitHub vendor adapter (A99): connects to GitHub's official hosted Streamable HTTP MCP server using either
 * a Jarvy-managed GitHub OAuth App (deployment env) or a Personal Access Token — identical full MCP toolset. */
export function createGitHubAdapter(mcp: RemoteMcpTransport): ConnectorAdapter {
  const probe = async (input: AdapterProbeInput): Promise<ConnectorProbeResult> => {
    const token = resolveBearer(input.headers, input.oauth);
    if (!token) return { outcome: "needs_auth", message: "Connect your GitHub account or provide a Personal Access Token" };
    const mcpUrl = resolveMcpUrl(input.url);
    const [probed, accountLabel] = await Promise.all([
      mcp.probe({ url: mcpUrl, authKind: "headers", headers: { Authorization: `Bearer ${token}` }, redirectUrl: input.redirectUrl }),
      fetchAccountLabel(token, mcpUrl),
    ]);
    if (probed.outcome === "connected" && accountLabel) return { ...probed, accountLabel };
    return probed;
  };

  const callTool = async (input: AdapterCallInput): Promise<ConnectorCallResult> => {
    const token = resolveBearer(input.headers, input.oauth);
    if (!token) return { outcome: "needs_auth", message: "GitHub is not connected" };
    return mcp.callTool({
      url: resolveMcpUrl(input.url),
      authKind: "headers",
      headers: { Authorization: `Bearer ${token}` },
      redirectUrl: input.redirectUrl,
      toolName: input.toolName,
      args: input.args,
      signal: input.signal,
    });
  };

  return {
    id: "github",
    name: "GitHub",
    kind: "remote_mcp",
    defaultUrl: GITHUB_MCP_URL,
    authMethods: ["oauth", "headers"],
    envVars: ["JARVY_GITHUB_CLIENT_ID", "JARVY_GITHUB_CLIENT_SECRET"],
    probe,
    callTool,
    startOAuth,
    completeOAuth,
  };
}
