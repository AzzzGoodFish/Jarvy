import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";

/** The root certificate is public, so devices can fetch it before signing in (A51). */
export function rootCertificateRoute(connection: ApiServices["connection"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/connection/root.crt", c => {
    const der = connection.rootCertificate();
    if (!der) throw new HTTPException(404, { message: "Jarvy serves HTTPS only when it listens beyond this machine" });
    return c.body(new Uint8Array(der), 200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": 'attachment; filename="jarvy-root.crt"' });
  });
  return routes;
}
/** How Jarvy is reached and whether plain HTTP from other machines is allowed (Settings → General). */
export function connectionRoutes(connection: ApiServices["connection"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/connection", c => c.json(connection.info()));
  routes.put("/connection", jsonBody, async c => {
    const input = await readJson(c);
    if (typeof input.allowHttp !== "boolean") throw new HTTPException(400, { message: "allowHttp must be true or false" });
    return c.json(connection.setAllowHttp(input.allowHttp));
  });
  return routes;
}
