import type { IncomingMessage } from "node:http";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv } from "../context.js";

/** Extracts the true client IP, honoring `X-Forwarded-For` / `X-Real-IP` ONLY when `trustProxy` is explicitly enabled
 * and the direct socket peer is loopback or private RFC1918 LAN (A112). */
export function normalizeIp(address: string | undefined): string {
  return (address ?? "unknown").replace(/^::ffff:/, "");
}

function isTrustedProxyPeer(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("127.")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:");
}

export function clientIpFromIncoming(req: IncomingMessage, trustProxy: boolean): string {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!trustProxy || !isTrustedProxyPeer(peer)) return peer;
  const xff = req.headers["x-forwarded-for"];
  const firstXff = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  if (firstXff && /^[0-9a-fA-F:.]{2,64}$/.test(firstXff)) return normalizeIp(firstXff);
  const realIp = req.headers["x-real-ip"];
  const singleReal = (Array.isArray(realIp) ? realIp[0] : realIp)?.trim();
  if (singleReal && /^[0-9a-fA-F:.]{2,64}$/.test(singleReal)) return normalizeIp(singleReal);
  return peer;
}

export function clientIp(c: Context<ApiEnv>, trustProxy: boolean): string {
  return clientIpFromIncoming(c.env.incoming, trustProxy);
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** Bounded in-memory token-bucket rate limiter per IP (A112). */
export class IpRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxEntries: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(options: { maxPerWindow: number; windowMs: number; burst?: number; maxEntries?: number }) {
    this.capacity = options.burst ?? options.maxPerWindow;
    this.refillPerMs = options.maxPerWindow / options.windowMs;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** Consumes 1 token for `key`. Returns `0` if allowed, or retry-after seconds if rate-limited. */
  take(key: string, now = Date.now()): number {
    let bucket = this.buckets.get(key);
    if (bucket) {
      const elapsed = Math.max(0, now - bucket.lastRefill);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.lastRefill = now;
      // Refresh LRU insertion order.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    } else {
      if (this.buckets.size >= this.maxEntries) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    const missing = 1 - bucket.tokens;
    return Math.max(1, Math.ceil(missing / this.refillPerMs / 1000));
  }
}

export function rateLimitMiddleware(
  limiter: IpRateLimiter,
  trustProxy: () => boolean,
  onLimited?: (ip: string, path: string) => void,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const ip = clientIp(c, trustProxy());
    const retryAfter = limiter.take(ip);
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      onLimited?.(ip, c.req.path);
      throw new HTTPException(429, { message: "Too many requests; try again later" });
    }
    await next();
  };
}
