import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ApiEnv, ApiServices } from "./context.js";
import { headers, apiSecurity } from "./middleware/security.js";
import { handleError } from "./middleware/errors.js";
import { installAuthentication } from "./routes/account.js";
import { botRoutes } from "./routes/bots.js";
import { chatRoutes, attachmentRoutes } from "./routes/chats.js";
import { modelRoutes } from "./routes/models.js";
import { eventRoutes } from "./routes/events.js";
import { channelRoutes } from "./routes/channels.js";
import { liveRoutes } from "./routes/live.js";
import { connectionRoutes, rootCertificateRoute } from "./routes/connection.js";
import { secretRoutes } from "./routes/secrets.js";
import { environmentRoutes } from "./routes/environments.js";

export function createHttpApp(services: ApiServices, webRoot: string) {
  const app = new Hono<ApiEnv>();
  app.use("*", headers);
  app.onError(handleError);

  const api = new Hono<ApiEnv>();
  api.use("*", apiSecurity);
  api.route("/", rootCertificateRoute(services.connection));
  installAuthentication(api, services.account);
  api.route("/bots", botRoutes(services.bots));
  api.route("/", channelRoutes(services));
  api.route("/chats", chatRoutes(services));
  api.route("/attachments", attachmentRoutes(services.chats));
  api.route("/", modelRoutes(services.models));
  api.route("/", eventRoutes(services));
  api.route("/", liveRoutes(services));
  api.route("/", connectionRoutes(services.connection));
  api.route("/secrets", secretRoutes(services.secrets));
  api.route("/environments", environmentRoutes(services.bots));
  api.all("*", () => { throw new HTTPException(404, { message: "API route not found" }); });
  app.route("/api", api);

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
