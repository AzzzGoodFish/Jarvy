import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";
import { botStatusView } from "../views/bot-status.js";

export function eventRoutes({ events, account, chats, bots }: ApiServices) {
  const routes = new Hono<ApiEnv>();
  routes.get("/events", c => {
    const actorId = c.get("actorId"), token = c.get("sessionToken"), signal = c.req.raw.signal;
    let disconnect!: (close?: boolean) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false;
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          if (ended) return;
          // Preserve the existing bounded SSE behavior: slow readers reconnect and reload SQLite facts.
          if ((controller.desiredSize ?? 0) <= 0) { disconnect(); return; }
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const unsubscribe = events.subscribe(change => {
          if (!account.authenticated(token)) { disconnect(); return; }
          if (change.kind === "chat" && chats.get(actorId, change.id)) send("chat", { chatId: change.id });
          if (change.kind === "sections" && change.ownerId === actorId) send("sections", {});
          // Something was delivered to this person (A41): the page re-reads its inbox.
          if (change.kind === "inbox" && change.memberId === actorId) send("inbox", {});
          if (change.kind === "bot" && bots.owns(change.id)) send("bot", { botId: change.id, status: botStatusView(change.status) });
          // The agent Bot created, changed or deleted Bots (A48): the page reloads them and its chats.
          if (change.kind === "bots") send("bots", {});
        }, () => disconnect());
        const heartbeat = setInterval(() => {
          if (!account.authenticated(token)) disconnect(); else send("heartbeat", {});
        }, 15_000);
        heartbeat.unref();
        const aborted = () => disconnect();
        disconnect = (close = true) => {
          if (ended) return;
          ended = true; clearInterval(heartbeat); unsubscribe(); signal.removeEventListener("abort", aborted);
          if (close) controller.close();
        };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) disconnect(); else send("ready", {});
      },
      cancel() { disconnect(false); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: c.env.outgoing.writableHighWaterMark }));
    return c.body(body, 200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  });
  return routes;
}
