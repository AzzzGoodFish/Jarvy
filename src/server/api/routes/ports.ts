import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";

/** The ports a Bot published from its sandbox (A74), for its owner in Bot info: listed with what each finds now, and
 * unpublished. Publishing is the Bot's, with ports.publish. */
export function portRoutes(services: Pick<ApiServices, "bots">) {
  const routes = new Hono<ApiEnv>();
  const bot = (id: string) => { services.bots.describe(id); return id; };
  routes.get("/bots/:id/ports", async c => c.json({ ports: await services.bots.ports.list(bot(c.req.param("id"))) }));
  routes.delete("/bots/:id/ports/:port", c => {
    const port = Number(c.req.param("port"));
    if (!Number.isInteger(port)) throw new HTTPException(400, { message: "port must be a number" });
    services.bots.ports.unpublish(bot(c.req.param("id")), port);
    return c.json({ ok: true });
  });
  return routes;
}
