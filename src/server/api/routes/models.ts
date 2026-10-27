import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";

export function modelRoutes(models: ApiServices["models"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/model-providers", c => c.json({ providers: models.providers() }));
  routes.get("/model-providers/:provider/models", c => c.json({ models: models.builtinModels(c.req.param("provider")) }));
  routes.get("/model-options", c => c.json({ connections: models.options() }));
  routes.post("/model-autoconfig", jsonBody, async c => c.json(models.autoconfigure(await readJson(c))));
  routes.post("/model-discovery", jsonBody, async c => c.json({ models: await models.discover(await readJson(c), c.req.raw.signal) }));

  const connections = new Hono<ApiEnv>();
  connections.get("/", c => c.json({ connections: models.list() }));
  connections.post("/", jsonBody, async c => c.json(models.create(await readJson(c)), 201));
  connections.put("/:id", jsonBody, async c => c.json(models.update(c.req.param("id"), await readJson(c))));
  connections.delete("/:id", async c => {
    await models.delete(c.req.param("id")); return c.json({ ok: true });
  });
  connections.get("/:id/catalog", async c => c.json({ models: await models.catalog(c.req.param("id")) }));
  // Resetting a built-in connection's models to the catalog (A62): what it would do, then doing it.
  connections.get("/:id/reset", async c => c.json(await models.resetPlan(c.req.param("id"))));
  connections.post("/:id/reset", async c => c.json(await models.reset(c.req.param("id"))));
  connections.put("/:id/credential", jsonBody, async c => c.json(models.saveCredential(c.req.param("id"), await readJson(c))));
  connections.post("/:id/models", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(models.saveModel(c.req.param("id"), input.model, typeof input.originalId === "string" ? input.originalId : undefined), 201);
  });
  connections.put("/:id/models", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(models.saveModel(c.req.param("id"), input.model, typeof input.originalId === "string" ? input.originalId : undefined));
  });
  connections.delete("/:id/models", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(models.deleteModel(c.req.param("id"), String(input.modelId ?? "")));
  });
  connections.get("/:id/auth", c => c.json(models.loginStatus(c.req.param("id"))));
  connections.post("/:id/auth", c => c.json(models.startLogin(c.req.param("id")), 202));
  connections.delete("/:id/auth", async c => c.json(await models.cancelLogin(c.req.param("id"))));
  connections.post("/:id/auth/input", jsonBody, async c => c.json(models.loginInput(c.req.param("id"), await readJson(c))));
  connections.post("/:id/auth/logout", async c => {
    await models.logout(c.req.param("id")); return c.json({ ok: true });
  });
  routes.route("/model-connections", connections);
  return routes;
}
