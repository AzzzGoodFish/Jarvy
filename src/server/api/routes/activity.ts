import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ActivityCursor } from "../../shared/activity.js";
import type { ApiEnv, ApiServices } from "../context.js";
import { messageView } from "../views/chat.js";

function cursor(raw: string | undefined): ActivityCursor | undefined {
  if (raw === undefined) return;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { throw new HTTPException(400, { message: "分页位置无效。" }); }
  if (value && typeof value === "object" && "timestamp" in value && Number.isSafeInteger(value.timestamp) && Number(value.timestamp) >= 0 && "kind" in value && "id" in value) {
    if (value.kind === "chat" && typeof value.id === "string" && value.id.length) return value as ActivityCursor;
    if (value.kind === "history" && Number.isSafeInteger(value.id) && Number(value.id) > 0) return value as ActivityCursor;
  }
  throw new HTTPException(400, { message: "分页位置无效。" });
}
export function activityRoutes(bots: ApiServices["bots"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/:id/activity", c => {
    const limit = Number(c.req.query("limit") ?? 40);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HTTPException(400, { message: "分页大小无效。" });
    const page = bots.activity(c.req.param("id"), cursor(c.req.query("before")), limit);
    return c.json({ items: page.items, nextBefore: page.nextBefore ? Buffer.from(JSON.stringify(page.nextBefore)).toString("base64url") : null });
  });
  routes.get("/:id/activity/messages/:messageId", c => {
    const detail = bots.activityMessage(c.req.param("id"), c.req.param("messageId"));
    return c.json({ chat: detail.chat, message: messageView(detail.message) });
  });
  routes.all("/:id/activity", () => { throw new HTTPException(405, { message: "活动历史仅支持查看。" }); });
  routes.all("/:id/activity/messages/:messageId", () => { throw new HTTPException(405, { message: "活动历史仅支持查看。" }); });
  return routes;
}
