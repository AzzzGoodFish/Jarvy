import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";

/** The turn a Bot is running, live (A47): `snapshot` with the turn so far (null when idle), then `start`, `patch` and
 * `end` as it goes. Only the Bot's owner, the signed-in person, may listen. A reader that falls behind is disconnected,
 * as on `/events`; it reconnects and starts again from a snapshot. */
export function liveRoutes({ account, bots }: ApiServices) {
  const routes = new Hono<ApiEnv>();
  routes.get("/bots/:id/live", c => {
    const token = c.get("sessionToken"), signal = c.req.raw.signal, live = bots.live(c.req.param("id"));
    let disconnect!: (close?: boolean) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false;
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          if (ended) return;
          if ((controller.desiredSize ?? 0) <= 0) { disconnect(); return; }
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const { turn, unsubscribe } = live.subscribe(update => {
          if (!account.authenticated(token)) { disconnect(); return; }
          send(update.type, update);
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
        if (signal.aborted) disconnect(); else send("snapshot", { turn });
      },
      cancel() { disconnect(false); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: c.env.outgoing.writableHighWaterMark }));
    return c.body(body, 200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  });
  return routes;
}
