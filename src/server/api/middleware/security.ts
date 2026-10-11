import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { ApiEnv } from "../context.js";

const appHeaders = secureHeaders({
  xFrameOptions: "DENY", referrerPolicy: "no-referrer",
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], connectSrc: ["'self'"], imgSrc: ["'self'", "data:"],
    styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], baseUri: ["'none'"], frameAncestors: ["'none'"],
  },
});
/** Running an HTML attachment (A35): scripts and network loads are allowed, but
 * `sandbox` gives the document an opaque origin — no cookies, and API calls arrive anonymous with
 * Origin null. Only Jarvy itself may frame it. */
const sandboxHeaders = secureHeaders({
  xFrameOptions: false, referrerPolicy: "no-referrer",
  contentSecurityPolicy: {
    sandbox: ["allow-scripts"], defaultSrc: ["*", "data:", "blob:", "'unsafe-inline'", "'unsafe-eval'"],
    formAction: ["'none'"], frameAncestors: ["'self'"],
  },
});
export const headers: MiddlewareHandler<ApiEnv> = async (c, next) => {
  let sandboxed = false;
  await appHeaders(c, async () => { await next(); sandboxed = !!c.get("sandboxedDocument"); });
  if (sandboxed) { await sandboxHeaders(c, async () => {}); c.res.headers.delete("X-Frame-Options"); }
};
export const apiSecurity: MiddlewareHandler<ApiEnv> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("origin");
  // Preserve CLI requests without Origin; browser mutations must be same-origin.
  if (origin && c.req.method !== "GET" && c.req.method !== "HEAD") {
    let allowed = false;
    try { allowed = new URL(origin).host === c.req.header("host"); } catch { /* Invalid origins are not trusted. */ }
    if (!allowed) throw new HTTPException(403, { message: "Origin not allowed" });
  }
  await next();
};
