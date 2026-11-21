import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ConnectorProvider } from "../../../contract/connectors.js";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { messageView } from "../views/chat.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

function callbackPage(result: { ok: boolean; name?: string; message: string }): string {
  const title = result.ok ? `${result.name ?? "Connector"} Connected` : "Authorization Failed";
  const accent = result.ok ? "#16a34a" : "#dc2626";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; padding: 24px; }
  main { max-width: 420px; width: 100%; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 24px; box-shadow: 0 8px 24px rgba(15,23,42,.06); }
  h1 { margin: 0 0 8px; font-size: 18px; color: ${accent}; }
  p { margin: 0; font-size: 14px; line-height: 1.5; color: #475569; overflow-wrap: anywhere; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(result.message)}</p></main></body>
</html>`;
}

/** Public OAuth callback route: registered before session auth because SameSite=Strict omits cookies on cross-site redirects. */
export function connectorCallbackRoute(connectors: ApiServices["connectors"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/connectors/oauth/callback", async c => {
    const result = await connectors.oauth.handleCallback({
      code: c.req.query("code"),
      state: c.req.query("state"),
      iss: c.req.query("iss"),
      error: c.req.query("error"),
      error_description: c.req.query("error_description"),
    });
    return c.html(callbackPage(result), result.ok ? 200 : 400);
  });
  return routes;
}

/** Settings → Connectors, ephemeral preset OAuth/token connection, and Bot access grants (A102). */
export function connectorRoutes(connectors: ApiServices["connectors"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/", c => c.json({ connectors: connectors.list(), presets: connectors.presets(), publicUrl: connectors.publicUrl() }));

  // Ephemeral preset connection flows: nothing is persisted until OAuth completes or the token verifies.
  routes.post("/presets/:provider/oauth/start", jsonBody, async c => {
    const input = await readJson(c).catch(() => ({} as Record<string, unknown>));
    return c.json(await connectors.oauth.startPreset(c.req.param("provider") as ConnectorProvider, input.redirectUri, input.name));
  });
  routes.post("/presets/:provider/token", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await connectors.connectToken({ provider: c.req.param("provider"), token: input.token, name: input.name }), 201);
  });
  routes.get("/oauth/flows/:flowId", c => c.json(connectors.oauth.presetStatus(c.req.param("flowId"))));
  routes.post("/oauth/flows/:flowId/complete", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await connectors.oauth.completePresetManual(c.req.param("flowId"), { callbackUrl: input.callbackUrl, code: input.code }));
  });
  routes.delete("/oauth/flows/:flowId", c => { connectors.oauth.cancelPreset(c.req.param("flowId")); return c.json({ ok: true }); });

  // Configured connector CRUD and existing-connector OAuth (Custom MCP, reconnect, in-chat request cards).
  routes.post("/", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await connectors.create({
      slug: input.slug, name: input.name, provider: input.provider, url: input.url, authKind: input.authKind,
      headers: input.headers, clientId: input.clientId, clientSecret: input.clientSecret,
    }), 201);
  });
  routes.put("/:id", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await connectors.update(c.req.param("id"), {
      name: input.name, url: input.url, authKind: input.authKind,
      headers: input.headers, clientId: input.clientId, clientSecret: input.clientSecret,
      unconfirmed: input.unconfirmed, enabled: input.enabled,
    }));
  });
  routes.delete("/:id", c => { connectors.delete(c.req.param("id")); return c.json({ ok: true }); });
  routes.post("/:id/probe", async c => c.json(await connectors.probe(c.req.param("id"))));
  routes.post("/:id/disconnect", c => c.json(connectors.disconnect(c.req.param("id"))));
  routes.post("/:id/oauth/start", jsonBody, async c => {
    const input = await readJson(c).catch(() => ({} as Record<string, unknown>));
    return c.json(await connectors.oauth.start(c.req.param("id"), input.redirectUri));
  });
  routes.post("/:id/oauth/complete", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await connectors.oauth.completeManual(c.req.param("id"), { callbackUrl: input.callbackUrl, code: input.code }));
  });
  routes.get("/:id/oauth/status", c => {
    const id = c.req.param("id");
    return c.json({ oauth: connectors.oauth.status(id), connector: connectors.get(id) });
  });
  routes.put("/:id/grants/:botId", jsonBody, async c => {
    const input = await readJson(c);
    if (typeof input.granted !== "boolean") throw new HTTPException(400, { message: "granted must be true or false" });
    return c.json(connectors.grant(c.req.param("id"), c.req.param("botId"), input.granted));
  });
  routes.get("/:id/uses", c => c.json({ uses: connectors.uses(c.req.param("id")) }));
  routes.post("/requests/:chatId/:messageId", async c => {
    const input = await readJson(c).catch(() => ({} as Record<string, unknown>));
    return c.json(messageView(await connectors.fulfilAuth(c.get("actorId"), c.req.param("chatId"), c.req.param("messageId"), { scope: input.scope })));
  });
  return routes;
}
