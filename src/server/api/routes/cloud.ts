import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";

/** Encrypted S3 cloud storage status and manual sync trigger for Settings → Storage (A107, A109). */
export function cloudRoutes(storage: ApiServices["storage"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/status", c => c.json(storage.status()));
  routes.post("/sync", async c => c.json(await storage.syncNow()));
  return routes;
}
