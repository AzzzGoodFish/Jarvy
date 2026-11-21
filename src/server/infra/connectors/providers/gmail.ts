import { randomBytes } from "node:crypto";
import type { ConnectorTool } from "../../../../contract/connectors.js";
import type {
  ConnectorCallResult, ConnectorProbeResult, ConnectorStartOAuthResult, McpOAuthSnapshot,
} from "../../../shared/connector.js";
import type {
  AdapterCallInput, AdapterCompleteOAuthInput, AdapterProbeInput, AdapterStartOAuthInput, ConnectorAdapter,
} from "../adapter.js";

const GMAIL_TOOLS: ConnectorTool[] = [
  {
    name: "search_messages",
    title: "Search emails",
    description: "Search emails in Gmail using Gmail query syntax (e.g. from:alice is:unread)",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Gmail search query" },
        maxResults: { type: "number", description: "Max emails to return (1-25, default 10)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_message",
    title: "Read email",
    description: "Read the headers and body of a Gmail message by ID",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Gmail message ID" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_draft",
    title: "Create draft",
    description: "Create a draft email in Gmail",
    readOnly: false,
    inputSchema: {
      type: "object",
      required: ["to", "subject", "body"],
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Plain-text email body" },
        cc: { type: "string", description: "Optional Cc recipients" },
        threadId: { type: "string", description: "Optional Gmail threadId to attach draft to" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "send_email",
    title: "Send email",
    description: "Send an email from your Gmail account",
    readOnly: false,
    inputSchema: {
      type: "object",
      required: ["to", "subject", "body"],
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Plain-text email body" },
        cc: { type: "string", description: "Optional Cc recipients" },
        threadId: { type: "string", description: "Optional Gmail threadId when replying" },
      },
      additionalProperties: false,
    },
  },
];

const trimSlash = (url: string) => url.replace(/\/+$/, "");

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch { return false; }
}

const tokenEndpointOf = (url: string) => (isLocalUrl(url) ? `${trimSlash(url)}/oauth/token` : "https://oauth2.googleapis.com/token");
const apiBaseOf = (url: string) => `${trimSlash(url)}/gmail/v1/users/me`;

async function ensureAccessToken(options: {
  url: string; oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string; signal?: AbortSignal;
}): Promise<{ token: string; snapshot?: McpOAuthSnapshot } | { needsAuth: string }> {
  const tokens = options.oauth?.tokens;
  if (!tokens?.access_token) return { needsAuth: "Connect your Google account" };
  const expiresAt = options.oauth?.tokensExpireAt;
  const expiring = typeof expiresAt === "number" && expiresAt <= Date.now() + 60_000;
  if (!expiring) return { token: tokens.access_token };
  if (!tokens.refresh_token || !options.clientId?.trim() || !options.clientSecret?.trim()) {
    return { needsAuth: "Gmail access token expired; reconnect your Google account" };
  }
  const form = new URLSearchParams({
    client_id: options.clientId.trim(),
    client_secret: options.clientSecret.trim(),
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(tokenEndpointOf(options.url), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: options.signal,
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    return { needsAuth: String(data.error_description ?? data.error ?? "Gmail token refresh failed") };
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  const snapshot: McpOAuthSnapshot = {
    serverUrl: options.url,
    tokens: {
      access_token: data.access_token,
      token_type: String(data.token_type ?? tokens.token_type ?? "Bearer"),
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : tokens.refresh_token,
      expires_in: expiresIn,
      scope: typeof data.scope === "string" ? data.scope : tokens.scope,
    },
    tokensExpireAt: Date.now() + expiresIn * 1000,
  };
  return { token: data.access_token, snapshot };
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function decodeBase64Url(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function extractBody(payload?: GmailPart): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64Url(payload.body.data);
  if (payload.parts?.length) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function encodeMimeMessage(input: { to: string; subject: string; body: string; cc?: string }): string {
  const lines = [
    `To: ${input.to.replace(/[\r\n]+/g, " ").trim()}`,
    ...(input.cc?.trim() ? [`Cc: ${input.cc.replace(/[\r\n]+/g, " ").trim()}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function probe(input: AdapterProbeInput): Promise<ConnectorProbeResult> {
  try {
    const resolved = await ensureAccessToken(input);
    if ("needsAuth" in resolved) return { outcome: "needs_auth", message: resolved.needsAuth };
    const res = await fetch(`${apiBaseOf(input.url)}/profile`, {
      headers: { Authorization: `Bearer ${resolved.token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { outcome: "needs_auth", message: "Gmail authorization expired", snapshot: resolved.snapshot };
    }
    if (!res.ok) return { outcome: "error", message: `Gmail API returned HTTP ${res.status}` };
    const profile = await res.json().catch(() => ({})) as { emailAddress?: string };
    return {
      outcome: "connected",
      tools: GMAIL_TOOLS,
      snapshot: resolved.snapshot,
      ...(profile.emailAddress ? { accountLabel: profile.emailAddress } : {}),
    };
  } catch (error) {
    return { outcome: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function callTool(input: AdapterCallInput): Promise<ConnectorCallResult> {
  try {
    const resolved = await ensureAccessToken(input);
    if ("needsAuth" in resolved) return { outcome: "needs_auth", message: resolved.needsAuth };
    const base = apiBaseOf(input.url);
    const { toolName, args, signal } = input;
    if (toolName === "search_messages") {
      const q = encodeURIComponent(String(args.query ?? ""));
      const maxResults = Math.min(25, Math.max(1, Number(args.maxResults) || 10));
      const res = await fetch(`${base}/messages?q=${q}&maxResults=${maxResults}`, {
        headers: { Authorization: `Bearer ${resolved.token}` }, signal,
      });
      if (res.status === 401) return { outcome: "needs_auth", message: "Gmail token expired", snapshot: resolved.snapshot };
      const text = await res.text();
      if (!res.ok) return { outcome: "ok", text, images: [], isError: true, snapshot: resolved.snapshot };
      const list = JSON.parse(text) as { messages?: { id: string; threadId?: string }[] };
      const details = await Promise.all((list.messages ?? []).slice(0, maxResults).map(async item => {
        const meta = await fetch(`${base}/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, {
          headers: { Authorization: `Bearer ${resolved.token}` }, signal,
        });
        if (!meta.ok) return { id: item.id, threadId: item.threadId };
        const msg = await meta.json() as { id: string; threadId?: string; snippet?: string; payload?: { headers?: { name?: string; value?: string }[] } };
        const hdrs = new Map((msg.payload?.headers ?? []).map(h => [(h.name ?? "").toLowerCase(), h.value ?? ""]));
        return {
          id: msg.id, threadId: msg.threadId, subject: hdrs.get("subject") ?? "",
          from: hdrs.get("from") ?? "", date: hdrs.get("date") ?? "", snippet: msg.snippet ?? "",
        };
      }));
      return { outcome: "ok", text: JSON.stringify(details, null, 2), images: [], isError: false, snapshot: resolved.snapshot };
    }
    if (toolName === "get_message") {
      const id = encodeURIComponent(String(args.id ?? ""));
      const res = await fetch(`${base}/messages/${id}?format=full`, {
        headers: { Authorization: `Bearer ${resolved.token}` }, signal,
      });
      if (res.status === 401) return { outcome: "needs_auth", message: "Gmail token expired", snapshot: resolved.snapshot };
      const text = await res.text();
      if (!res.ok) return { outcome: "ok", text, images: [], isError: true, snapshot: resolved.snapshot };
      const data = JSON.parse(text) as { id: string; threadId?: string; snippet?: string; payload?: GmailPart & { headers?: { name?: string; value?: string }[] } };
      const hdrs = new Map((data.payload?.headers ?? []).map(h => [(h.name ?? "").toLowerCase(), h.value ?? ""]));
      return {
        outcome: "ok",
        text: JSON.stringify({
          id: data.id, threadId: data.threadId,
          subject: hdrs.get("subject") ?? "", from: hdrs.get("from") ?? "",
          to: hdrs.get("to") ?? "", cc: hdrs.get("cc") ?? "", date: hdrs.get("date") ?? "",
          body: extractBody(data.payload) || data.snippet || "",
        }, null, 2),
        images: [], isError: false, snapshot: resolved.snapshot,
      };
    }
    if (toolName === "create_draft" || toolName === "send_email") {
      const raw = encodeMimeMessage({
        to: String(args.to ?? ""),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
        ...(args.cc ? { cc: String(args.cc) } : {}),
      });
      const threadId = args.threadId ? String(args.threadId) : undefined;
      const endpoint = toolName === "create_draft" ? `${base}/drafts` : `${base}/messages/send`;
      const payload = toolName === "create_draft"
        ? { message: { raw, ...(threadId ? { threadId } : {}) } }
        : { raw, ...(threadId ? { threadId } : {}) };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${resolved.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal,
      });
      if (res.status === 401) return { outcome: "needs_auth", message: "Gmail token expired", snapshot: resolved.snapshot };
      return { outcome: "ok", text: await res.text(), images: [], isError: !res.ok, snapshot: resolved.snapshot };
    }
    return { outcome: "error", message: `Unknown Gmail tool "${toolName}"` };
  } catch (error) {
    return { outcome: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function startOAuth(input: AdapterStartOAuthInput): Promise<ConnectorStartOAuthResult> {
  if (!input.clientId?.trim() || !input.clientSecret?.trim()) {
    throw new Error("Gmail requires a Google Cloud OAuth Client ID and Client Secret");
  }
  const state = randomBytes(16).toString("hex");
  const authBase = isLocalUrl(input.url) ? `${trimSlash(input.url)}/oauth/authorize` : "https://accounts.google.com/o/oauth2/v2/auth";
  const authUrl = new URL(authBase);
  authUrl.searchParams.set("client_id", input.clientId.trim());
  authUrl.searchParams.set("redirect_uri", input.redirectUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.modify");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "select_account consent");
  authUrl.searchParams.set("state", state);
  return { outcome: "redirect", authUrl: authUrl.toString(), state, snapshot: { serverUrl: input.url, oauthState: state } };
}

async function completeOAuth(input: AdapterCompleteOAuthInput): Promise<McpOAuthSnapshot> {
  if (!input.clientId?.trim() || !input.clientSecret?.trim()) {
    throw new Error("Gmail requires both Client ID and Client Secret");
  }
  const form = new URLSearchParams({
    client_id: input.clientId.trim(),
    client_secret: input.clientSecret.trim(),
    code: input.code,
    redirect_uri: input.redirectUrl,
    grant_type: "authorization_code",
  });
  const res = await fetch(tokenEndpointOf(input.url), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: input.signal,
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(String(data.error_description ?? data.error ?? `Gmail token exchange failed (${res.status})`));
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : input.oauth?.tokens?.refresh_token;
  return {
    serverUrl: input.url,
    tokens: {
      access_token: data.access_token,
      token_type: String(data.token_type ?? "Bearer"),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
      ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
    },
    ...(expiresIn !== undefined ? { tokensExpireAt: Date.now() + expiresIn * 1000 } : {}),
  };
}

/** Built-in Gmail vendor adapter (A102): Google Cloud OAuth (deployment env) with automatic refresh-token renewal. */
export const gmailAdapter: ConnectorAdapter = {
  id: "gmail",
  name: "Gmail",
  kind: "builtin",
  defaultUrl: "https://gmail.googleapis.com",
  authMethods: ["oauth"],
  envVars: ["JARVY_GMAIL_CLIENT_ID", "JARVY_GMAIL_CLIENT_SECRET"],
  probe,
  callTool,
  startOAuth,
  completeOAuth,
};
