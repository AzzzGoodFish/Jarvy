import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { sessionCookieName } from "./account.js";

/** Device-accessible update status route: readable by either an authenticated owner session OR a registered
 * `Authorization: Device <token>` so desktop/CLI clients can learn about releases via the server (A113). */
export function systemUpdateDeviceRoute(services: Pick<ApiServices, "update" | "account" | "bots">) {
  const routes = new Hono<ApiEnv>();
  routes.get("/system/update", c => {
    const isTls = !!(c.env.incoming.socket as { encrypted?: boolean }).encrypted;
    const sessionToken = getCookie(c, sessionCookieName(services.account.instance, isTls));
    const deviceToken = /^Device\s+(\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!services.account.authenticated(sessionToken) && !services.bots.devices.hasDeviceToken(deviceToken)) {
      throw new HTTPException(401, { message: "Login or registered device token required" });
    }
    return c.json(services.update.status());
  });
  return routes;
}

/** Owner-authenticated update check & apply routes (A113). */
export function systemUpdateRoutes(update: ApiServices["update"]) {
  const routes = new Hono<ApiEnv>();
  routes.post("/check", async c => c.json(await update.checkNow()));
  routes.post("/apply", jsonBody, async c => {
    const input = await readJson(c).catch(() => ({} as Record<string, unknown>));
    const version = typeof input.version === "string" ? input.version : undefined;
    return c.json(await update.apply(version), 202);
  });
  return routes;
}
