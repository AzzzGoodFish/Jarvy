import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { QuotaWindow } from "../../../../contract/models.js";

/** A provider's usage check (A94): its limits read with the connection's signed-in, refreshed credential. */
export interface QuotaReading { windows: QuotaWindow[]; plan?: string }
export type QuotaCheck = (credential: OAuthCredential & Record<string, unknown>, signal: AbortSignal) => Promise<QuotaReading>;

/** A check is quick or it is given up: it never holds the page, and a Bot's requests never wait for it. */
const TIMEOUT_MS = 8_000;

export class QuotaHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  const body = await response.text();
  if (!response.ok) throw new QuotaHttpError(response.status, `${new URL(url).host} ${response.status}: ${errorText(body)}`);
  try { return JSON.parse(body) as unknown; }
  catch { throw new Error(`${new URL(url).host} returned something other than JSON`); }
}
/** The provider's own words from an error body, short. */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; detail?: unknown };
    const error = parsed.error as { message?: unknown } | string | undefined;
    const text = typeof error === "string" ? error : typeof error?.message === "string" ? error.message
      : typeof parsed.message === "string" ? parsed.message : typeof parsed.detail === "string" ? parsed.detail : undefined;
    if (text) return text.slice(0, 200);
  } catch { /* not JSON */ }
  return body.replace(/\s+/g, " ").trim().slice(0, 200) || "no details";
}

export type Json = Record<string, unknown>;
export const record = (value: unknown): Json | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
/** A number, also when sent as a string. */
export function num(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}
/** A time as milliseconds: an ISO date, or seconds or milliseconds since 1970. */
export function time(value: unknown): number | undefined {
  const count = num(value);
  if (count !== undefined) return count > 1e12 ? count : count * 1000;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
/** A share between 0 and 1, to four places. */
export const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
/** A window's kind from its length in seconds. */
export function span(seconds: number | undefined): Pick<QuotaWindow, "kind" | "hours"> | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const hours = seconds / 3600;
  if (hours < 24) return { kind: "hours", hours: Math.max(1, Math.round(hours)) };
  if (hours < 48) return { kind: "day" };
  if (hours <= 24 * 8) return { kind: "week" };
  return { kind: "month" };
}
