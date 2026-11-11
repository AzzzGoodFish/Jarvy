import { createHash } from "node:crypto";

/** Google's Cloud Code Assist API as the Antigravity app calls it (A91). Ported from pi-antigravity (MIT, see
 * THIRD_PARTY_NOTICE.md): the endpoints in the order it tries them, and the client it says it is. Google gates which
 * models an account sees on this version, so it follows the extension's when Google moves on. */
export const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
export const USER_AGENT = "antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";
/** Looking up the project or the models is quick; an endpoint that stalls gives way to the next one. */
const LOOKUP_TIMEOUT_MS = 8_000;

export function apiHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": USER_AGENT };
}

type Json = Record<string, unknown>;
export const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The backend's own words from an error body, else the body. */
export function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch { /* not JSON */ }
  return body.slice(0, 500);
}

async function call(endpoint: string, method: string, token: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const response = await fetch(`${endpoint}/v1internal:${method}`, { method: "POST", headers: apiHeaders(token), body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${method} ${response.status}: ${errorMessage(raw)}`);
  return JSON.parse(raw) as unknown;
}

/** The project ID wherever a response puts it: a field of several names, an object's `id`, or the first of a list. */
export function projectIn(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct = data.antigravityProjectId ?? data.projectId ?? data.backendProjectId ?? data.userDefinedCloudaicompanionProject
    ?? data.cloudaicompanionProject ?? data.project;
  const id = text(direct) ?? (isRecord(direct) ? text(direct.id) : undefined);
  if (id) return id;
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const list = data[key];
    if (Array.isArray(list)) for (const item of list) { const found = text(item) ?? projectIn(item); if (found) return found; }
  }
  return undefined;
}

/** The account's Cloud Code Assist project: `loadCodeAssist` on the first endpoint that answers, else the project list. */
export async function findProject(token: string, signal?: AbortSignal): Promise<string | undefined> {
  for (const endpoint of ENDPOINTS) {
    try {
      const project = projectIn(await call(endpoint, "loadCodeAssist", token, { metadata: { ideType: "ANTIGRAVITY" } }, signal));
      return project ?? projectIn(await call(endpoint, "listCloudAICompanionProjects", token, {}, signal));
    } catch { signal?.throwIfAborted(); }
  }
  return undefined;
}

/** When no project is found the extension sends a UUID made from the account's email, which the backend accepts. */
export const fallbackProject = (email: string | undefined) => uuidFrom(`antigravity:${email || "antigravity-default"}`);
/** A name-based UUID (version 5 layout over SHA-1), the same for the same seed. */
export function uuidFrom(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface RawModels { models: Record<string, Json>; sorts?: unknown }

/** `fetchAvailableModels` from every endpoint at once, merged: some models are only on the daily or sandbox one. */
export async function fetchModels(token: string, project: string, signal?: AbortSignal): Promise<RawModels> {
  const results = await Promise.allSettled(ENDPOINTS.map(endpoint => call(endpoint, "fetchAvailableModels", token, { project }, signal)));
  const models: Record<string, Json> = {};
  let sorts: unknown, failure: unknown;
  for (const result of results) {
    if (result.status === "rejected") { failure ??= result.reason; continue; }
    const data = result.value;
    if (!isRecord(data) || !isRecord(data.models)) continue;
    for (const [id, info] of Object.entries(data.models)) if (isRecord(info)) models[id] = info;
    if (Array.isArray(data.agentModelSorts)) sorts = data.agentModelSorts;
  }
  if (!Object.keys(models).length) throw failure instanceof Error ? failure : new Error("fetchAvailableModels returned no models");
  return { models, sorts };
}
