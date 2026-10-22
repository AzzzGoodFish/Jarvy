import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";

/** A Bot's scheduled tasks, for its owner in Bot info (A57). The Bot manages the same tasks with its tasks tools. */
export function taskRoutes(services: Pick<ApiServices, "bots" | "tasks">) {
  const routes = new Hono<ApiEnv>();
  // The Bot must exist and be the owner's; describe throws 404 otherwise.
  const bot = (id: string) => { services.bots.describe(id); return id; };
  routes.get("/bots/:id/tasks", c => c.json({ tasks: services.tasks.list(bot(c.req.param("id"))) }));
  routes.post("/bots/:id/tasks", jsonBody, async c => c.json(services.tasks.create(bot(c.req.param("id")), await readJson(c)), 201));
  routes.put("/bots/:id/tasks/:taskId", jsonBody, async c => c.json(services.tasks.update(bot(c.req.param("id")), c.req.param("taskId"), await readJson(c))));
  routes.post("/bots/:id/tasks/:taskId/:action{pause|resume}", c =>
    c.json(services.tasks.setState(bot(c.req.param("id")), c.req.param("taskId"), c.req.param("action") === "pause" ? "paused" : "active")));
  routes.delete("/bots/:id/tasks/:taskId", c => { services.tasks.remove(bot(c.req.param("id")), c.req.param("taskId")); return c.json({ ok: true }); });
  return routes;
}
