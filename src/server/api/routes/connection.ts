import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { IpRateLimiter, rateLimitMiddleware } from "../middleware/rate-limit.js";

/** The root certificate is public, so devices can fetch it before signing in (A51), rate-limited against floods (A112). */
export function rootCertificateRoute(connection: ApiServices["connection"], account?: ApiServices["account"]) {
  const routes = new Hono<ApiEnv>();
  const limiter = new IpRateLimiter({ maxPerWindow: 30, windowMs: 60_000, burst: 15 });
  routes.use("/connection/root.crt", rateLimitMiddleware(
    limiter,
    () => account?.runtimeSecurityFlags().trustProxy ?? false,
    (ip, path) => account?.audit("rate_limited", ip, `GET ${path}`),
  ));
  routes.get("/connection/root.crt", c => {
    const der = connection.rootCertificate();
    if (!der) throw new HTTPException(404, { message: "Jarvy serves HTTPS only when it listens beyond this machine" });
    return c.body(new Uint8Array(der), 200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": 'attachment; filename="jarvy-root.crt"' });
  });
  return routes;
}
/** How Jarvy is reached, whether plain HTTP from other machines is allowed, and the ports published ones take (A74)
 * (Settings → General). Each field is changed alone. */
export function connectionRoutes(connection: ApiServices["connection"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/connection", c => c.json(connection.info()));
  routes.put("/connection", jsonBody, async c => {
    const input = await readJson(c);
    if (input.ports !== undefined) return c.json(connection.setPortRange(input.ports));
    if (typeof input.allowHttp !== "boolean") throw new HTTPException(400, { message: "allowHttp must be true or false" });
    return c.json(connection.setAllowHttp(input.allowHttp));
  });
  return routes;
}
