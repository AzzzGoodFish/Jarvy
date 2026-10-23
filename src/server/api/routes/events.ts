import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";
import { eventStream } from "../event-stream.js";
import { botStatusView } from "../views/bot-status.js";

export function eventRoutes({ events, account, chats, bots }: ApiServices) {
  const routes = new Hono<ApiEnv>();
  routes.get("/events", c => {
    const actorId = c.get("actorId"), token = c.get("sessionToken");
    return eventStream(c, () => account.authenticated(token), ({ send, close, signedIn }) => ({
      unsubscribe: events.subscribe(signedIn(change => {
        if (change.kind === "chat" && chats.get(actorId, change.id)) send("chat", { chatId: change.id });
        if (change.kind === "sections" && change.ownerId === actorId) send("sections", {});
        // Something was delivered to this person (A41): the page re-reads its inbox.
        if (change.kind === "inbox" && change.memberId === actorId) send("inbox", {});
        if (change.kind === "bot" && bots.owns(change.id)) send("bot", { botId: change.id, status: botStatusView(change.status) });
        // The agent Bot created, changed or deleted Bots (A48): the page reloads them and its chats.
        if (change.kind === "bots") send("bots", {});
      }), close),
      ready: () => send("ready", {}),
    }));
  });
  return routes;
}
