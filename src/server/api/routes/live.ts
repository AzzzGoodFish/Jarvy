import { Hono } from "hono";
import type { ApiEnv, ApiServices } from "../context.js";
import { eventStream } from "../event-stream.js";

/** The turn a Bot is running, live (A47): `snapshot` with the turn so far (null when idle) and the server's clock, then
 * `start`, `patch` and `end` as it goes. Only the Bot's owner, the signed-in person, may listen. A reader that falls behind is disconnected,
 * as on `/events`; it reconnects and starts again from a snapshot. */
export function liveRoutes({ account, bots }: ApiServices) {
  const routes = new Hono<ApiEnv>();
  routes.get("/bots/:id/live", c => {
    const token = c.get("sessionToken"), live = bots.live(c.req.param("id"));
    return eventStream(c, () => account.authenticated(token), ({ send, close, signedIn }) => {
      const { turn, unsubscribe } = live.subscribe(signedIn(update => send(update.type, update)), close);
      // `now` lets the page line its clock up with the server's for the running times.
      return { unsubscribe, ready: () => send("snapshot", { turn, now: Date.now() }) };
    });
  });
  return routes;
}
