import { randomBytes } from "node:crypto";
import type { ConnectorTool } from "../../../contract/connectors.js";
import type { McpCallResult, McpOAuthSnapshot, McpProbeResult, McpStartOAuthResult } from "../../shared/connector.js";

export const GMAIL_TOOLS: ConnectorTool[] = [
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

function tokenEndpointOf(baseUrl: string): string {
  return isLocalUrl(baseUrl) ? `${trimSlash(baseUrl)}/oauth/token` : "https://oauth2.googleapis.com/token";
}

async function refreshGmailToken(options: {
  url: string; oauth: McpOAuthSnapshot; clientId?: string; clientSecret?: string; signal?: AbortSignal;
}): Promise<McpOAuthSnapshot | null> {
  const refresh = options.oauth.tokens?.refresh_token;
  if (!refresh || !options.clientId?.trim() || !options.clientSecret?.trim()) return null;
  const form = new URLSearchParams({
    client_id: options.clientId.trim(),
    client_secret: options.clientSecret.trim(),
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const res = await fetch(tokenEndpointOf(options.url), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: options.signal,
  });
  if (!res.ok) return null;
  const data = await res.json() as Record<string, unknown>;
  if (typeof data.access_token !== "string") return null;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
  return {
    ...options.oauth,
    tokens: {
      ...options.oauth.tokens,
      access_token: data.access_token,
      token_type: String(data.token_type ?? "Bearer"),
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : refresh,
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    },
    ...(expiresIn !== undefined ? { tokensExpireAt: Date.now() + expiresIn * 1000 } : {}),
  };
}

async function ensureToken(options: {
  url: string; oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string; signal?: AbortSignal;
}): Promise<{ token: string; snapshot?: McpOAuthSnapshot } | null> {
  const oauth = options.oauth;
  if (!oauth?.tokens?.access_token) return null;
  if (oauth.tokensExpireAt && Date.now() >= oauth.tokensExpireAt - 60_000 && oauth.tokens.refresh_token) {
    const refreshed = await refreshGmailToken({ ...options, oauth });
    if (refreshed?.tokens?.access_token) return { token: refreshed.tokens.access_token, snapshot: refreshed };
  }
  return { token: oauth.tokens.access_token };
}

function encodeMimeMessage(input: { to: string; subject: string; body: string; cc?: string }): string {
  const cleanHeader = (val: string) => val.replace(/[\r\n]+/g, " ").trim();
  const subj = cleanHeader(input.subject);
  const encodedSubj = /[^\x20-\x7E]/.test(subj) ? `=?UTF-8?B?${Buffer.from(subj, "utf8").toString("base64")}?=` : subj;
  const lines = [
    `To: ${cleanHeader(input.to)}`,
    ...(input.cc?.trim() ? [`Cc: ${cleanHeader(input.cc)}`] : []),
    `Subject: ${encodedSubj}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function extractBody(payload?: GmailPart): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const found = extractBody(part);
      if (found) return found;
    }
  }
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf8");
  return "";
}

export async function probeGmail(options: {
  url: string; oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string;
}): Promise<McpProbeResult> {
  const resolved = await ensureToken(options);
  if (!resolved) {
    return {
      outcome: "needs_auth",
      message: options.clientId ? "Sign in with Google to connect Gmail" : "Enter your Google Cloud OAuth Client ID and Client Secret",
    };
  }
  try {
    const res = await fetch(`${trimSlash(options.url)}/gmail/v1/users/me/profile`, {
      headers: { Authorization: `Bearer ${resolved.token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { outcome: "needs_auth", message: "Gmail authorization expired or unauthorized", snapshot: resolved.snapshot };
    }
    if (!res.ok) return { outcome: "error", message: `Gmail API returned HTTP ${res.status}` };
    const profile = await res.json().catch(() => ({})) as { emailAddress?: string };
    const accountLabel = typeof profile.emailAddress === "string" ? profile.emailAddress.trim() : undefined;
    return { outcome: "connected", tools: GMAIL_TOOLS, snapshot: resolved.snapshot, ...(accountLabel ? { accountLabel } : {}) };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function callGmailTool(options: {
  url: string; oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string;
  toolName: string; args: Record<string, unknown>; signal?: AbortSignal;
}): Promise<McpCallResult> {
  const resolved = await ensureToken(options);
  if (!resolved) return { outcome: "needs_auth", message: "Gmail authentication required" };
  const base = `${trimSlash(options.url)}/gmail/v1/users/me`;
  const { toolName, args, signal } = options;

  try {
    if (toolName === "search_messages") {
      const q = String(args.query ?? "").trim();
      const maxResults = Math.min(25, Math.max(1, Number(args.maxResults ?? 10)));
      const res = await fetch(`${base}/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`, {
        headers: { Authorization: `Bearer ${resolved.token}` },
        signal,
      });
      if (res.status === 401) return { outcome: "needs_auth", message: "Gmail token expired", snapshot: resolved.snapshot };
      const text = await res.text();
      return { outcome: "ok", text, images: [], isError: !res.ok, snapshot: resolved.snapshot };
    }
    if (toolName === "get_message") {
      const id = encodeURIComponent(String(args.id ?? ""));
      const res = await fetch(`${base}/messages/${id}?format=full`, {
        headers: { Authorization: `Bearer ${resolved.token}` },
        signal,
      });
      if (res.status === 401) return { outcome: "needs_auth", message: "Gmail token expired", snapshot: resolved.snapshot };
      if (!res.ok) return { outcome: "ok", text: await res.text(), images: [], isError: true, snapshot: resolved.snapshot };
      const data = await res.json() as {
        id?: string; threadId?: string; snippet?: string;
        payload?: GmailPart & { headers?: { name?: string; value?: string }[] };
      };
      const hdrs = new Map((data.payload?.headers ?? []).map(h => [(h.name ?? "").toLowerCase(), h.value ?? ""]));
      const summary = {
        id: data.id,
        threadId: data.threadId,
        subject: hdrs.get("subject") ?? "",
        from: hdrs.get("from") ?? "",
        to: hdrs.get("to") ?? "",
        cc: hdrs.get("cc") ?? "",
        date: hdrs.get("date") ?? "",
        body: extractBody(data.payload) || data.snippet || "",
      };
      return { outcome: "ok", text: JSON.stringify(summary, null, 2), images: [], isError: false, snapshot: resolved.snapshot };
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
        body: JSON.stringify(payload),
        signal,
      });
      if (res.status === 401) return { outcome: "needs_auth", message: "Gmail token expired", snapshot: resolved.snapshot };
      return { outcome: "ok", text: await res.text(), images: [], isError: !res.ok, snapshot: resolved.snapshot };
    }
    return { outcome: "error", message: `Unknown Gmail tool "${toolName}"` };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function startGmailOAuth(options: {
  url: string; clientId?: string; clientSecret?: string; redirectUrl: string;
}): Promise<McpStartOAuthResult> {
  if (!options.clientId?.trim() || !options.clientSecret?.trim()) {
    throw new Error("Gmail requires a Google Cloud OAuth Client ID and Client Secret");
  }
  const state = randomBytes(16).toString("hex");
  const authBase = isLocalUrl(options.url) ? `${trimSlash(options.url)}/oauth/authorize` : "https://accounts.google.com/o/oauth2/v2/auth";
  const authUrl = new URL(authBase);
  authUrl.searchParams.set("client_id", options.clientId.trim());
  authUrl.searchParams.set("redirect_uri", options.redirectUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.modify");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  return {
    outcome: "redirect",
    authUrl: authUrl.toString(),
    state,
    snapshot: { serverUrl: options.url, oauthState: state },
  };
}

export async function completeGmailOAuth(options: {
  url: string; oauth?: McpOAuthSnapshot; clientId?: string; clientSecret?: string; redirectUrl: string; code: string; signal?: AbortSignal;
}): Promise<McpOAuthSnapshot> {
  if (!options.clientId?.trim() || !options.clientSecret?.trim()) {
    throw new Error("Gmail requires both Client ID and Client Secret");
  }
  const form = new URLSearchParams({
    client_id: options.clientId.trim(),
    client_secret: options.clientSecret.trim(),
    code: options.code,
    redirect_uri: options.redirectUrl,
    grant_type: "authorization_code",
  });
  const res = await fetch(tokenEndpointOf(options.url), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: options.signal,
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    throw new Error(String(data.error_description ?? data.error ?? `Gmail token exchange failed (${res.status})`));
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : options.oauth?.tokens?.refresh_token;
  return {
    serverUrl: options.url,
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
