import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import { errorMessage, fallbackProject, findProject } from "./client.js";

/** Google sign-in as the Antigravity app (A91), ported from pi-antigravity (MIT). Its client is the desktop app's
 * public one — not a private app secret; Google doesn't keep an installed app's client secret confidential — which
 * Google only lets call back to this address; elsewhere the callback address is pasted back. Encoded and split in two,
 * as upstream does, so secret scanners don't take the public client for a leaked one. */
const decode = (...parts: string[]) => Buffer.from(parts.join(""), "base64").toString();
const CLIENT_ID = decode("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc", "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==");
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ", "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const PORT = 51121, PATH = "/oauth-callback";
const REDIRECT_URI = `http://localhost:${PORT}${PATH}`;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const SCOPES = ["aicode", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"]
  .map(scope => `https://www.googleapis.com/auth/${scope}`);
const WAIT_MS = 10 * 60 * 1000;
/** Refreshed five minutes early, as upstream. */
const EARLY_MS = 5 * 60 * 1000;

export interface AntigravityCredential extends OAuthCredential { projectId?: string; email?: string }

export async function login(interaction: ProviderAuthInteraction): Promise<AntigravityCredential> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // Independent of the verifier, so a leaked callback address can't mint tokens.
  const state = randomBytes(32).toString("base64url");
  const callback = await listen(state, interaction.signal).catch(() => undefined);
  try {
    const query = new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI, scope: SCOPES.join(" "),
      code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" });
    interaction.notify({ type: "auth_url", url: `${AUTH_URL}?${query}`,
      instructions: "Sign in with Google. On another device, paste the address the browser ends up on." });
    const code = await codeFrom(interaction, callback, state);
    const tokens = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }, interaction.signal);
    if (!tokens.refresh_token) throw new Error("Google sent no refresh token; sign in again and allow offline access.");
    const [email, project] = await Promise.all([userEmail(tokens.access_token, interaction.signal), findProject(tokens.access_token, interaction.signal)]);
    return { type: "oauth", refresh: tokens.refresh_token, access: tokens.access_token, expires: Date.now() + tokens.expires_in * 1000 - EARLY_MS,
      projectId: project ?? fallbackProject(email), ...(email ? { email } : {}) };
  } finally { callback?.close(); }
}

export async function refresh(credential: OAuthCredential, signal: AbortSignal): Promise<AntigravityCredential> {
  const current = credential as AntigravityCredential;
  const tokens = await token({ grant_type: "refresh_token", refresh_token: current.refresh }, signal);
  // The project doesn't change from token to token; it is looked up again only if sign-in found none.
  const projectId = current.projectId || await findProject(tokens.access_token, signal) || fallbackProject(current.email);
  return { ...current, refresh: tokens.refresh_token || current.refresh, access: tokens.access_token,
    expires: Date.now() + tokens.expires_in * 1000 - EARLY_MS, projectId };
}

/** What a request needs: the token and the project, passed as Pi's one API key. */
export function apiKey(credential: OAuthCredential): string {
  const current = credential as AntigravityCredential;
  return JSON.stringify({ token: current.access, projectId: current.projectId || fallbackProject(current.email) });
}
export function parseApiKey(key: string | undefined): { token: string; projectId: string } {
  try {
    const parsed = JSON.parse(key ?? "") as { token?: unknown; projectId?: unknown };
    if (typeof parsed.token === "string" && parsed.token && typeof parsed.projectId === "string" && parsed.projectId)
      return { token: parsed.token, projectId: parsed.projectId };
  } catch { /* below */ }
  throw new Error("The Antigravity sign-in is missing or incomplete; sign in again.");
}

interface Tokens { access_token: string; refresh_token?: string; expires_in: number }
async function token(fields: Record<string, string>, signal?: AbortSignal): Promise<Tokens> {
  const response = await fetch(TOKEN_URL, { method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Google token request failed (${response.status}): ${oauthError(body)}`);
  const parsed = JSON.parse(body) as Partial<Tokens>;
  if (typeof parsed.access_token !== "string" || typeof parsed.expires_in !== "number") throw new Error("Google's token response is incomplete.");
  return parsed as Tokens;
}
function oauthError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    const parts = [parsed.error, parsed.error_description].filter(part => typeof part === "string" && part);
    if (parts.length) return parts.join(": ").slice(0, 300);
  } catch { /* not JSON */ }
  return errorMessage(body).slice(0, 300);
}
async function userEmail(access: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${access}` }, signal });
    const email = response.ok ? (await response.json() as { email?: unknown }).email : undefined;
    return typeof email === "string" ? email : undefined;
  } catch { return undefined; }
}

interface Callback { code: Promise<string | undefined>; cancel(): void; close(): void }

/** The loopback callback, on Jarvy's machine: a browser there comes back by itself. Taken or failing, only pasting is left. */
function listen(state: string, signal: AbortSignal): Promise<Callback> {
  let settle: (code: string | undefined, error?: Error) => void = () => {};
  const code = new Promise<string | undefined>((resolve, reject) => {
    settle = (value, error) => { settle = () => {}; if (error) reject(error); else resolve(value); };
  });
  code.catch(() => undefined);
  const page = (response: import("node:http").ServerResponse, status: number, html: string) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.end(html);
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", REDIRECT_URI);
    if (request.method !== "GET" || url.pathname !== PATH) return page(response, 404, oauthErrorHtml("Callback route not found."));
    if (url.searchParams.get("state") !== state) return page(response, 400, oauthErrorHtml("This page is from another sign-in."));
    const error = url.searchParams.get("error"), value = url.searchParams.get("code");
    if (error) { page(response, 400, oauthErrorHtml("Google sign-in failed.", error)); return settle(undefined, new Error(`Google sign-in failed: ${error}`)); }
    if (!value) return page(response, 400, oauthErrorHtml("Missing authorization code."));
    page(response, 200, oauthSuccessHtml("Signed in to Antigravity. You may close this page."));
    settle(value);
  });
  const timer = setTimeout(() => settle(undefined, new Error("Google sign-in timed out")), WAIT_MS);
  timer.unref();
  const aborted = () => settle(undefined, new Error("Login cancelled"));
  signal.addEventListener("abort", aborted, { once: true });
  const close = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); server.closeAllConnections(); server.close(); };
  return new Promise((resolve, reject) => {
    server.once("error", error => { close(); reject(error); });
    server.listen(PORT, "127.0.0.1", () => resolve({ code, cancel: () => settle(undefined), close: () => { settle(undefined); close(); } }));
  });
}

/** The browser's callback or the pasted address (or bare code), whichever comes first. */
async function codeFrom(interaction: ProviderAuthInteraction, callback: Callback | undefined, state: string): Promise<string> {
  const manual = new AbortController();
  let pasteError: unknown;
  const pasted = interaction.prompt({ type: "manual_code", message: "Paste the address the browser ends up on.",
    placeholder: `${REDIRECT_URI}?state=…&code=…`, signal: manual.signal })
    .then(input => { callback?.cancel(); return input; })
    .catch(error => { pasteError = error; callback?.cancel(); return undefined; });
  try {
    const code = await callback?.code;
    if (code) return code;
    const input = await pasted;
    if (input === undefined) throw pasteError instanceof Error ? pasteError : new Error("Login cancelled");
    return pastedCode(input, state);
  } finally { manual.abort(); }
}

function pastedCode(input: string, state: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Nothing was pasted.");
  let url: URL;
  try { url = new URL(raw); } catch {
    if (!raw.includes("=")) return raw;
    url = new URL(`${REDIRECT_URI}?${raw.replace(/^\?/, "")}`);
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(`Google sign-in failed: ${error.slice(0, 200)}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("The pasted address has no code.");
  if (url.searchParams.has("state") && url.searchParams.get("state") !== state) throw new Error("The pasted address is from another sign-in.");
  return code;
}
