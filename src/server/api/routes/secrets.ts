import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { messageView } from "../views/chat.js";

/** Settings → Secrets (A52). Values go in and never come back out. */
export function secretRoutes(secrets: ApiServices["secrets"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/", c => c.json(secrets.list()));
  routes.post("/", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(secrets.create({ name: input.name, description: input.description, value: input.value }), 201);
  });
  routes.put("/:id", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(secrets.update(c.req.param("id"), { description: input.description, value: input.value }));
  });
  routes.delete("/:id", c => { secrets.delete(c.req.param("id")); return c.json({ ok: true }); });
  routes.put("/:id/grants/:botId", jsonBody, async c => {
    const input = await readJson(c);
    if (typeof input.granted !== "boolean") throw new HTTPException(400, { message: "granted must be true or false" });
    return c.json(secrets.grant(c.req.param("id"), c.req.param("botId"), input.granted));
  });
  routes.get("/:id/uses", c => c.json({ uses: secrets.uses(c.req.param("id")) }));
  /** The owner's answer on a Bot's request card: the value (when needed) and how long the Bot may use it. */
  routes.post("/requests/:chatId/:messageId", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(messageView(secrets.fulfil(c.get("actorId"), c.req.param("chatId"), c.req.param("messageId"), { value: input.value, scope: input.scope })));
  });
  return routes;
}
