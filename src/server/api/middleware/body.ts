import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv } from "../context.js";

const MAX_JSON_BYTES = 64 * 1024;

/** Enforces the 64 KiB JSON body cap without calling `new Request(c.req.raw, ...)` (which fails on chunked bodies under
 * Node 24's undici with `@hono/node-server` `overrideGlobalObjects: false`). Actual streamed bytes are bounded in `readJson`. */
export const jsonBody: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const len = Number(c.req.header("content-length"));
  if (Number.isFinite(len) && len > MAX_JSON_BYTES) throw new HTTPException(413, { message: "Request is too large" });
  await next();
};

async function readBoundedText(c: Context<ApiEnv>, maxBytes: number): Promise<string> {
  const body = c.req.raw.body;
  if (!body) return c.req.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HTTPException(413, { message: "Request is too large" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function readJson(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) throw new HTTPException(415, { message: "JSON content type required" });
  const text = await readBoundedText(c, MAX_JSON_BYTES);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HTTPException(400, { message: "Invalid JSON object" }); }
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new HTTPException(400, { message: "Invalid JSON object" });
  return value as Record<string, unknown>;
}
export function textField(input: Record<string, unknown>, key: string, fallback?: string): string {
  if (input[key] === undefined && fallback !== undefined) return fallback;
  if (typeof input[key] !== "string") throw new HTTPException(400, { message: `${key} must be a string` });
  return input[key];
}
