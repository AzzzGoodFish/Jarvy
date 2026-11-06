import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";

/** The start of a usage period (ms); the client picks the start of its own local day (A46). */
export function since(raw: string | undefined): number {
  const value = Number(raw ?? "");
  if (!/^\d+$/.test(raw ?? "") || !Number.isSafeInteger(value)) throw new HTTPException(400, { message: "Invalid start time" });
  return value;
}

/** Usage across every Bot (A81). One Bot's own usage is `GET /bots/:id/usage` (history.ts). */
export function usageRoutes(bots: ApiServices["bots"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/usage", c => c.json(bots.usage(since(c.req.query("since")))));
  return routes;
}
