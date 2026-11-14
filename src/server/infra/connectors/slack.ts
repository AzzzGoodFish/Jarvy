import { randomBytes } from "node:crypto";
import type { ConnectorTool } from "../../../contract/connectors.js";
import type { McpCallResult, McpOAuthSnapshot, McpProbeResult, McpStartOAuthResult } from "../../shared/connector.js";

export const SLACK_TOOLS: ConnectorTool[] = [
  {
    name: "list_channels",
    title: "List channels",
    description: "List Slack channels in the workspace",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max channels to return (1-100, default 20)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_messages",
    title: "Read messages",
    description: "Read recent messages from a Slack channel",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["channel"],
      properties: {
        channel: { type: "string", description: "Slack channel ID (e.g. C01234567)" },
        limit: { type: "number", description: "Max messages to return (1-50, default 15)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_thread",
    title: "Read thread",
    description: "Read replies in a Slack message thread",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["channel", "thread_ts"],
      properties: {
        channel: { type: "string", description: "Slack channel ID" },
        thread_ts: { type: "string", description: "Parent message timestamp" },
        limit: { type: "number", description: "Max replies to return (1-50, default 20)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    title: "Send message",
    description: "Post a message or thread reply to a Slack channel",
    readOnly: false,
    inputSchema: {
      type: "object",
      required: ["channel", "text"],
      properties: {
        channel: { type: "string", description: "Slack channel ID or name" },
        text: { type: "string", description: "Message text" },
        thread_ts: { type: "string", description: "Optional thread timestamp to reply in a thread" },
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

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

export async function probeSlack(options: {
  url: string; headers?: Record<string, string>; oauth?: McpOAuthSnapshot;
}): Promise<McpProbeResult> {
  const token = resolveBearer(options.headers, options.oauth);
  if (!token) return { outcome: "needs_auth", message: "Connect your Slack workspace or provide a Slack token" };
  try {
    const res = await fetch(`${trimSlash(options.url)}/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    });
    if (res.status === 401) return { outcome: "needs_auth", message: "Slack token expired or unauthorized" };
    const data = await res.json() as { ok?: boolean; error?: string };
    if (!data.ok) {
      if (data.error && AUTH_ERRORS.has(data.error)) return { outcome: "needs_auth", message: `Slack auth error: ${data.error}` };
      return { outcome: "error", message: `Slack error: ${data.error ?? res.status}` };
    }
    return { outcome: "connected", tools: SLACK_TOOLS };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function callSlackTool(options: {
  url: string; headers?: Record<string, string>; oauth?: McpOAuthSnapshot;
  toolName: string; args: Record<string, unknown>; signal?: AbortSignal;
}): Promise<McpCallResult> {
  const token = resolveBearer(options.headers, options.oauth);
  if (!token) return { outcome: "needs_auth", message: "Slack authentication required" };
  const base = trimSlash(options.url);
  const { toolName, args, signal } = options;

  try {
    let res: Response;
    if (toolName === "list_channels") {
      const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
      res = await fetch(`${base}/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } else if (toolName === "read_messages") {
      const channel = encodeURIComponent(String(args.channel ?? ""));
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 15)));
      res = await fetch(`${base}/conversations.history?channel=${channel}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } else if (toolName === "read_thread") {
      const channel = encodeURIComponent(String(args.channel ?? ""));
      const ts = encodeURIComponent(String(args.thread_ts ?? ""));
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      res = await fetch(`${base}/conversations.replies?channel=${channel}&ts=${ts}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } else if (toolName === "send_message") {
      res = await fetch(`${base}/chat.postMessage`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          channel: String(args.channel ?? ""),
          text: String(args.text ?? ""),
          ...(args.thread_ts ? { thread_ts: String(args.thread_ts) } : {}),
        }),
        signal,
      });
    } else {
      return { outcome: "error", message: `Unknown Slack tool "${toolName}"` };
    }

    if (res.status === 401) return { outcome: "needs_auth", message: "Slack token expired or unauthorized" };
    const text = await res.text();
    let parsed: { ok?: boolean; error?: string } | null = null;
    try { parsed = JSON.parse(text); } catch { /* plain text */ }
    if (parsed && parsed.ok === false && parsed.error && AUTH_ERRORS.has(parsed.error)) {
      return { outcome: "needs_auth", message: `Slack auth error: ${parsed.error}` };
    }
    return { outcome: "ok", text, images: [], isError: !res.ok || parsed?.ok === false };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function startSlackOAuth(options: {
  url: string; clientId?: string; redirectUrl: string;
}): Promise<McpStartOAuthResult> {
  if (!options.clientId?.trim()) throw new Error("Slack OAuth requires a Client ID and Client Secret (or switch to Token)");
  const state = randomBytes(16).toString("hex");
  const authBase = isLocalUrl(options.url) ? `${trimSlash(options.url)}/oauth/authorize` : "https://slack.com/oauth/v2/authorize";
  const authUrl = new URL(authBase);
  authUrl.searchParams.set("client_id", options.clientId.trim());
  authUrl.searchParams.set("redirect_uri", options.redirectUrl);
  authUrl.searchParams.set("scope", "channels:read,channels:history,groups:read,groups:history,chat:write");
  authUrl.searchParams.set("state", state);
  return {
    outcome: "redirect",
    authUrl: authUrl.toString(),
    state,
    snapshot: { serverUrl: options.url, oauthState: state },
  };
}

export async function completeSlackOAuth(options: {
  url: string; clientId?: string; clientSecret?: string; redirectUrl: string; code: string; signal?: AbortSignal;
}): Promise<McpOAuthSnapshot> {
  if (!options.clientId?.trim() || !options.clientSecret?.trim()) {
    throw new Error("Slack OAuth requires both Client ID and Client Secret");
  }
  const tokenEndpoint = isLocalUrl(options.url) ? `${trimSlash(options.url)}/oauth/token` : `${trimSlash(options.url)}/oauth.v2.access`;
  const form = new URLSearchParams({
    client_id: options.clientId.trim(),
    client_secret: options.clientSecret.trim(),
    code: options.code,
    redirect_uri: options.redirectUrl,
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: options.signal,
  });
  const data = await res.json() as {
    ok?: boolean; error?: string; access_token?: string; token_type?: string; scope?: string;
    authed_user?: { access_token?: string };
  };
  const accessToken = data.access_token || data.authed_user?.access_token;
  if (!res.ok || data.ok === false || !accessToken) {
    throw new Error(String(data.error ?? `Slack token exchange failed (${res.status})`));
  }
  return {
    serverUrl: options.url,
    tokens: {
      access_token: accessToken,
      token_type: data.token_type ?? "Bearer",
      ...(data.scope ? { scope: data.scope } : {}),
    },
  };
}
