import { randomBytes } from "node:crypto";
import type { ConnectorTool } from "../../../contract/connectors.js";
import type { McpCallResult, McpOAuthSnapshot, McpProbeResult, McpStartOAuthResult } from "../../shared/connector.js";

export const GITHUB_TOOLS: ConnectorTool[] = [
  {
    name: "search_issues",
    title: "Search issues",
    description: "Search GitHub issues and pull requests across repositories",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "GitHub search query, e.g. repo:owner/name is:issue is:open" },
        limit: { type: "number", description: "Max items to return (1-30, default 10)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_issues",
    title: "List issues",
    description: "List issues in a GitHub repository",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["owner", "repo"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
        limit: { type: "number", description: "Max items to return (1-30, default 10)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_issue",
    title: "Get issue",
    description: "Read a GitHub issue or pull request and its recent comments",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "number"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_issue",
    title: "Create issue",
    description: "Create a new issue in a GitHub repository",
    readOnly: false,
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "title"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_comment",
    title: "Add comment",
    description: "Add a comment to a GitHub issue or pull request",
    readOnly: false,
    inputSchema: {
      type: "object",
      required: ["owner", "repo", "number", "body"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
        body: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function resolveBearer(headers?: Record<string, string>, oauth?: McpOAuthSnapshot): string | null {
  if (oauth?.tokens?.access_token) return oauth.tokens.access_token;
  const raw = headers?.Authorization ?? headers?.authorization;
  if (!raw) return null;
  return raw.replace(/^Bearer\s+/i, "").trim() || null;
}

async function ghFetch(baseUrl: string, path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${trimSlash(baseUrl)}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Jarvy-Connector",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

export async function probeGitHub(options: {
  url: string; headers?: Record<string, string>; oauth?: McpOAuthSnapshot;
}): Promise<McpProbeResult> {
  const token = resolveBearer(options.headers, options.oauth);
  if (!token) return { outcome: "needs_auth", message: "Connect your GitHub account or provide a Personal Access Token" };
  try {
    const res = await ghFetch(options.url, "/user", token);
    if (res.status === 401 || res.status === 403) return { outcome: "needs_auth", message: "GitHub token expired or unauthorized" };
    if (!res.ok) return { outcome: "error", message: `GitHub API returned HTTP ${res.status}` };
    return { outcome: "connected", tools: GITHUB_TOOLS };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function callGitHubTool(options: {
  url: string; headers?: Record<string, string>; oauth?: McpOAuthSnapshot;
  toolName: string; args: Record<string, unknown>; signal?: AbortSignal;
}): Promise<McpCallResult> {
  const token = resolveBearer(options.headers, options.oauth);
  if (!token) return { outcome: "needs_auth", message: "GitHub authentication required" };
  const base = options.url;
  const { toolName, args, signal } = options;

  try {
    let res: Response;
    if (toolName === "search_issues") {
      const q = String(args.query ?? "").trim();
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 10)));
      res = await ghFetch(base, `/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`, token, { signal });
    } else if (toolName === "list_issues") {
      const owner = encodeURIComponent(String(args.owner ?? ""));
      const repo = encodeURIComponent(String(args.repo ?? ""));
      const state = encodeURIComponent(String(args.state ?? "open"));
      const limit = Math.min(30, Math.max(1, Number(args.limit ?? 10)));
      res = await ghFetch(base, `/repos/${owner}/${repo}/issues?state=${state}&per_page=${limit}`, token, { signal });
    } else if (toolName === "get_issue") {
      const owner = encodeURIComponent(String(args.owner ?? ""));
      const repo = encodeURIComponent(String(args.repo ?? ""));
      const num = encodeURIComponent(String(args.number ?? ""));
      res = await ghFetch(base, `/repos/${owner}/${repo}/issues/${num}`, token, { signal });
    } else if (toolName === "create_issue") {
      const owner = encodeURIComponent(String(args.owner ?? ""));
      const repo = encodeURIComponent(String(args.repo ?? ""));
      res = await ghFetch(base, `/repos/${owner}/${repo}/issues`, token, {
        method: "POST",
        body: JSON.stringify({
          title: String(args.title ?? ""),
          ...(args.body ? { body: String(args.body) } : {}),
          ...(Array.isArray(args.labels) ? { labels: args.labels.map(String) } : {}),
        }),
        signal,
      });
    } else if (toolName === "create_comment") {
      const owner = encodeURIComponent(String(args.owner ?? ""));
      const repo = encodeURIComponent(String(args.repo ?? ""));
      const num = encodeURIComponent(String(args.number ?? ""));
      res = await ghFetch(base, `/repos/${owner}/${repo}/issues/${num}/comments`, token, {
        method: "POST",
        body: JSON.stringify({ body: String(args.body ?? "") }),
        signal,
      });
    } else {
      return { outcome: "error", message: `Unknown GitHub tool "${toolName}"` };
    }

    if (res.status === 401) return { outcome: "needs_auth", message: "GitHub token expired or unauthorized" };
    const text = await res.text();
    return { outcome: "ok", text, images: [], isError: !res.ok };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function startGitHubOAuth(options: {
  url: string; clientId?: string; redirectUrl: string;
}): Promise<McpStartOAuthResult> {
  if (!options.clientId?.trim()) throw new Error("GitHub OAuth requires a Client ID and Client Secret (or switch to Token)");
  const state = randomBytes(16).toString("hex");
  const authBase = isLocalUrl(options.url) ? `${trimSlash(options.url)}/oauth/authorize` : "https://github.com/login/oauth/authorize";
  const authUrl = new URL(authBase);
  authUrl.searchParams.set("client_id", options.clientId.trim());
  authUrl.searchParams.set("redirect_uri", options.redirectUrl);
  authUrl.searchParams.set("scope", "repo read:user");
  authUrl.searchParams.set("state", state);
  return {
    outcome: "redirect",
    authUrl: authUrl.toString(),
    state,
    snapshot: { serverUrl: options.url, oauthState: state },
  };
}

export async function completeGitHubOAuth(options: {
  url: string; clientId?: string; clientSecret?: string; redirectUrl: string; code: string; signal?: AbortSignal;
}): Promise<McpOAuthSnapshot> {
  if (!options.clientId?.trim() || !options.clientSecret?.trim()) {
    throw new Error("GitHub OAuth requires both Client ID and Client Secret");
  }
  const tokenEndpoint = isLocalUrl(options.url) ? `${trimSlash(options.url)}/oauth/token` : "https://github.com/login/oauth/access_token";
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: options.clientId.trim(),
      client_secret: options.clientSecret.trim(),
      code: options.code,
      redirect_uri: options.redirectUrl,
    }),
    signal: options.signal,
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(String(data.error_description ?? data.error ?? `GitHub token exchange failed (${res.status})`));
  }
  return {
    serverUrl: options.url,
    tokens: {
      access_token: data.access_token,
      token_type: String(data.token_type ?? "Bearer"),
      ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
    },
  };
}
