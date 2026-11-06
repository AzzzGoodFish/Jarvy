import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { RuntimeFault } from "../../shared/runtime.js";
import { since } from "./usage.js";

function integer(raw: string, label: string) {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new HTTPException(400, { message: `Invalid ${label}` });
  return n;
}
export function historyRoutes(bots: ApiServices["bots"]) {
  const routes = new Hono<ApiEnv>();
  // History spans Chats. Ownership is checked by the Bot service, not Chat membership.
  routes.get("/:id/history", c => {
    const memory = bots.memory(c.req.param("id"));
    const before = c.req.query("before"), limit = integer(c.req.query("limit") ?? "50", "page size");
    if (limit > 100) throw new HTTPException(400, { message: "The page size can't be over 100" });
    return c.json(memory.list(before === undefined ? undefined : integer(before, "page position"), limit));
  });
  routes.get("/:id/history/:recordId{[0-9]+}", c => {
    const detail = bots.memory(c.req.param("id")).read(integer(c.req.param("recordId"), "record ID"));
    if (!detail) throw new RuntimeFault("history_missing", "History record not found", 404);
    return c.json(detail);
  });
  // Token use and cost per model since a time (A46).
  routes.get("/:id/usage", c => {
    const from = since(c.req.query("since"));
    return c.json({ since: from, models: bots.memory(c.req.param("id")).usage(from) });
  });
  routes.all("/:id/history", () => { throw new HTTPException(405, { message: "History is read-only" }); });
  routes.all("/:id/history/:recordId{[0-9]+}", () => { throw new HTTPException(405, { message: "History is read-only" }); });
  return routes;
}
