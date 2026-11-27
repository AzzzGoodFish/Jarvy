import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ApiEnv, ApiServices } from "./context.js";
import { createSecurityHeaders, apiSecurity } from "./middleware/security.js";
import { handleError } from "./middleware/errors.js";
import { installAuthentication } from "./routes/account.js";
import { botRoutes } from "./routes/bots.js";
import { chatRoutes, attachmentRoutes } from "./routes/chats.js";
import { modelRoutes } from "./routes/models.js";
import { eventRoutes } from "./routes/events.js";
import { channelRoutes } from "./routes/channels.js";
import { liveRoutes } from "./routes/live.js";
import { connectionRoutes, rootCertificateRoute } from "./routes/connection.js";
import { cloudRoutes } from "./routes/cloud.js";
import { secretRoutes } from "./routes/secrets.js";
import { connectorCallbackRoute, connectorRoutes } from "./routes/connectors.js";
import { deviceDaemonRoute, environmentRoutes } from "./routes/environments.js";
import { envFileRoutes } from "./routes/env-files.js";
import { taskRoutes } from "./routes/tasks.js";
import { terminalRoutes } from "./routes/terminals.js";
import { portRoutes } from "./routes/ports.js";
import { usageRoutes } from "./routes/usage.js";
import { systemUpdateDeviceRoute, systemUpdateRoutes } from "./routes/update.js";

export interface HttpAppOptions {
  /** Disable serving the web frontend static assets (`--no-web`, A112) to minimize public attack surface. */
  noWeb?: boolean;
  /** Returns true while the server is draining for shutdown/restart (A114). */
  isDraining?: () => boolean;
}

export function createHttpApp(services: ApiServices, webRoot: string | null, options: HttpAppOptions = {}) {
  const app = new Hono<ApiEnv>();
  app.use("*", createSecurityHeaders(() => services.connection.allowHttp()));
  if (options.isDraining) {
    const isDraining = options.isDraining;
    app.use("*", async (c, next) => {
      if (isDraining()) {
        c.header("Connection", "close");
        c.header("Retry-After", "5");
        if (c.req.path.startsWith("/api/")) return c.json({ error: "Server is restarting" }, 503);
        return c.text("Service Unavailable", 503);
      }
      return next();
    });
  }
  app.onError(handleError);

  const api = new Hono<ApiEnv>();
  api.use("*", apiSecurity);
  api.route("/", rootCertificateRoute(services.connection, services.account));
  api.route("/", deviceDaemonRoute(services.bots, services.account));
  api.route("/", systemUpdateDeviceRoute(services));
  api.route("/", connectorCallbackRoute(services.connectors));
  installAuthentication(api, services.account);
  api.route("/system/update", systemUpdateRoutes(services.update));
  api.route("/", taskRoutes(services));
  api.route("/", portRoutes(services));
  api.route("/", usageRoutes(services.bots));
  api.route("/bots", botRoutes(services.bots));
  api.route("/", channelRoutes(services));
  api.route("/chats", chatRoutes(services));
  api.route("/attachments", attachmentRoutes(services.chats));
  api.route("/", modelRoutes(services.models));
  api.route("/", eventRoutes(services));
  api.route("/", liveRoutes(services));
  api.route("/", connectionRoutes(services.connection));
  api.route("/cloud", cloudRoutes(services.storage));
  api.route("/secrets", secretRoutes(services.secrets));
  api.route("/connectors", connectorRoutes(services.connectors));
  api.route("/environments", environmentRoutes(services.bots, services.connection));
  api.route("/environments", envFileRoutes(services.envFiles));
  api.route("/terminals", terminalRoutes(services.terminals));
  api.all("*", () => { throw new HTTPException(404, { message: "API route not found" }); });
  app.route("/api", api);

  if (options.noWeb || !webRoot) {
    // Headless API-only mode: return minimal 404 without HTML or Jarvy fingerprint.
    app.all("*", c => c.text("Not Found", 404));
    return app;
  }

  app.get("*", serveStatic({ root: webRoot, onFound: (path, c) => {
    c.header("Cache-Control", path.endsWith("index.html") ? "no-store" : "public, max-age=3600");
  } }));
  app.get("*", serveStatic({ root: webRoot, path: "index.html", onFound: (_, c) => { c.header("Cache-Control", "no-store"); } }));
  app.all("*", c => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") throw new HTTPException(405, { message: "Method not allowed" });
    throw new HTTPException(404, { message: "Web assets missing; run npm run build" });
  });
  return app;
}
