import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv } from "../context.js";

export const jsonBody = bodyLimit({ maxSize: 64 * 1024, onError: () => { throw new HTTPException(413, { message: "Request is too large" }); } });

export async function readJson(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) throw new HTTPException(415, { message: "JSON content type required" });
  let value: unknown;
  try { value = await c.req.json(); } catch { throw new HTTPException(400, { message: "Invalid JSON object" }); }
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new HTTPException(400, { message: "Invalid JSON object" });
  return value as Record<string, unknown>;
}
export function textField(input: Record<string, unknown>, key: string, fallback?: string): string {
  if (input[key] === undefined && fallback !== undefined) return fallback;
  if (typeof input[key] !== "string") throw new HTTPException(400, { message: `${key} must be a string` });
  return input[key];
}
