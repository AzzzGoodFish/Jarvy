import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";
import { HTTPException } from "hono/http-exception";
import { jsonBody, readJson, textField } from "../middleware/body.js";
import { botStatusView } from "../views/bot-status.js";
import { activityRoutes } from "./activity.js";
import { historyRoutes } from "./history.js";

export function botRoutes(bots: ApiServices["bots"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/", c => c.json({ bots: bots.list() }));
  routes.post("/", jsonBody, async c => {
    const input = await readJson(c);
    // Names are unique (A37); a taken one is name_taken. Without `environment` a Bot gets a sandbox when
    // Docker is there (A50).
    return c.json(bots.create(textField(input, "name"), input.environment === undefined ? undefined : environmentKind(input.environment)), 201);
  });
  // The default environment (`home`), whether the Bot may use the owner's computer (`hostGranted`), or an SSH
  // machine (`machineId` with `granted`, A57).
  routes.put("/:id/environment", jsonBody, async c => {
    const input = await readJson(c), id = c.req.param("id");
    if (input.machineId !== undefined) {
      if (typeof input.machineId !== "string" || typeof input.granted !== "boolean") throw new HTTPException(400, { message: "machineId and granted (true or false) are needed" });
      return c.json(bots.grantMachine(id, input.machineId, input.granted));
    }
    if (input.hostGranted === undefined) return c.json(bots.setHome(id, environmentKind(input.home)));
    if (typeof input.hostGranted !== "boolean") throw new HTTPException(400, { message: "hostGranted must be true or false" });
    return c.json(bots.grantHost(id, input.hostGranted));
  });
  routes.post("/:id/computer/:action", async c => {
    const action = c.req.param("action");
    if (action !== "start" && action !== "stop" && action !== "reset") throw new HTTPException(404, { message: "Not found" });
    return c.json(await bots.computer(c.req.param("id"), action));
  });
  routes.get("/:id", c => c.json(bots.describe(c.req.param("id"))));
  // Deleting a Bot keeps its workspace unless the caller asks otherwise.
  routes.delete("/:id", async c => {
    await bots.delete(c.req.param("id"), c.req.query("files") !== "delete");
    return c.json({ ok: true });
  });
  routes.put("/:id", jsonBody, async c => {
    const id = c.req.param("id"), input = await readJson(c);
    bots.get(id).identity.update({ name: textField(input, "name"), description: textField(input, "description", ""), persona: textField(input, "systemPrompt", "") });
    return c.json(bots.describe(id));
  });
  routes.put("/:id/model", jsonBody, async c => {
    const id = c.req.param("id");
    await bots.selectModel(id, await readJson(c));
    return c.json(bots.describe(id));
  });
  routes.get("/:id/status", c => c.json(botStatusView(bots.status(c.req.param("id")))));
  routes.get("/:id/runs", c => c.json({ runs: bots.runs(c.req.param("id")) }));
  routes.post("/:id/retry", c => {
    const id = c.req.param("id");
    bots.describe(id); bots.retry(id);
    return c.json({ ok: true }, 202);
  });
  routes.post("/:id/start", async c => {
    const id = c.req.param("id"); await bots.get(id).start();
    return c.json(botStatusView(bots.status(id)));
  });
  routes.post("/:id/stop", async c => {
    const id = c.req.param("id"); await bots.get(id).stop();
    return c.json(botStatusView(bots.status(id)));
  });
  routes.post("/:id/abort", async c => {
    const id = c.req.param("id"); await bots.get(id).abort();
    return c.json(botStatusView(bots.status(id)));
  });
  routes.put("/:id/color", jsonBody, async c => {
    const id = c.req.param("id");
    bots.get(id).identity.setColor((await readJson(c)).color);
    return c.json(bots.describe(id));
  });
  routes.route("/", historyRoutes(bots));
  routes.route("/", activityRoutes(bots));
  return routes;
}

function environmentKind(value: unknown): "computer" | "host" {
  if (value !== "computer" && value !== "host") throw new HTTPException(400, { message: "environment must be computer or host" });
  return value;
}
