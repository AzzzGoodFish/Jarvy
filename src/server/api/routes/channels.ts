import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { chatView, messageView, threadView } from "../views/chat.js";
import type { SearchResult } from "../../../contract/chat.js";

/** Sections, channels, members, notices, read positions and threads (A37). */
export function channelRoutes({ chats }: Pick<ApiServices, "chats">) {
  const routes = new Hono<ApiEnv>();
  const channels = chats.channels;
  const chat = (actorId: string, id: string) => {
    const found = chats.get(actorId, id);
    if (!found) throw new HTTPException(404, { message: "Chat not found" });
    return chatView(found, member => chats.member(member));
  };
  routes.get("/members", c => c.json({ members: channels.everyone(c.get("actorId")) }));
  // The search box: ?q=text[&in=chatId][&limit=N]. Chats come only without `in`; each message comes with its chat.
  routes.get("/search", c => {
    const within = c.req.query("in") || undefined, limit = Number(c.req.query("limit") ?? 50), view = (found: Parameters<typeof chatView>[0]) => chatView(found, member => chats.member(member));
    const found = chats.find(c.get("actorId"), c.req.query("q") ?? "", { within, limit });
    const result: SearchResult = { chats: found.chats.map(view), messages: found.messages.map(({ message, chat: place }) => ({ message: messageView(message), chat: view(place) })) };
    return c.json(result);
  });
  // Emoji marks (A39) and per-member pins.
  routes.put("/messages/:id/reaction", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(messageView(chats.react(c.get("actorId"), c.req.param("id"), input.emoji, input.on ?? true)));
  });
  // Folding a message to one line (A60): the interface only.
  routes.put("/messages/:id/fold", jsonBody, async c =>
    c.json(messageView(chats.fold(c.get("actorId"), c.req.param("id"), (await readJson(c)).folded))));
  // A person's inbox (A41): what was delivered to them, and "I have seen it".
  routes.put("/chats/:id/mute", jsonBody, async c => c.json(chat(c.get("actorId"), chats.mute(c.get("actorId"), c.req.param("id"), (await readJson(c)).muted).id)));
  routes.put("/chats/:id/pin", jsonBody, async c => c.json(chat(c.get("actorId"), chats.pin(c.get("actorId"), c.req.param("id"), (await readJson(c)).pinned).id)));
  // A Bot's DMs with other Bots (read-only for its owner) and the chats it subscribed to.
  routes.get("/members/:id/dms", c => c.json({ chats: chats.botDirects(c.get("actorId"), c.req.param("id")).map(item => chatView(item, id => chats.member(id))) }));
  routes.get("/members/:id/subscriptions", c => c.json({ chats: chats.subscriptions(c.get("actorId"), c.req.param("id")).map(item => chatView(item, id => chats.member(id))) }));
  routes.get("/sections", c => c.json({ sections: channels.sections(c.get("actorId")) }));
  routes.post("/sections", jsonBody, async c => c.json(channels.createSection(c.get("actorId"), await readJson(c)), 201));
  routes.patch("/sections/:id", jsonBody, async c => c.json(channels.updateSection(c.get("actorId"), c.req.param("id"), await readJson(c))));
  routes.delete("/sections/:id", c => {
    if (!channels.deleteSection(c.get("actorId"), c.req.param("id"))) throw new HTTPException(404, { message: "Section not found" });
    return c.json({ ok: true });
  });
  routes.post("/channels", jsonBody, async c => {
    const actor = c.get("actorId");
    return c.json(chat(actor, channels.createChannel(actor, await readJson(c))), 201);
  });
  // A channel's name, topic and group, or a thread's title and status.
  routes.patch("/chats/:id", jsonBody, async c => {
    const actor = c.get("actorId"), id = c.req.param("id"), input = await readJson(c);
    if (chats.get(actor, id)?.type === "thread") chats.threads.update(actor, id, input);
    else channels.updateChannel(actor, id, input);
    return c.json(chat(actor, id));
  });
  routes.get("/chats/:id", c => c.json(chat(c.get("actorId"), c.req.param("id"))));
  routes.get("/messages/:id", c => {
    const found = chats.message(c.get("actorId"), c.req.param("id"));
    if (!found) throw new HTTPException(404, { message: "Message not found" });
    return c.json(messageView(found));
  });
  routes.post("/messages/:id/thread", c => {
    const actor = c.get("actorId");
    return c.json(chat(actor, chats.threads.open(actor, c.req.param("id")).id));
  });
  routes.get("/chats/:id/threads", c => c.json({ threads: chats.threads.list(c.get("actorId"), c.req.param("id")).map(entry => threadView(entry, id => chats.member(id))) }));
  routes.get("/threads", c => c.json({ threads: chats.threads.followed(c.get("actorId")).map(entry => threadView(entry, id => chats.member(id))) }));
  routes.put("/chats/:id/follow", jsonBody, async c => {
    const actor = c.get("actorId"), id = c.req.param("id");
    chats.threads.setFollowing(actor, id, (await readJson(c)).following);
    return c.json(chat(actor, id));
  });
  routes.post("/chats/:id/members", jsonBody, async c => {
    const actor = c.get("actorId"), id = c.req.param("id");
    channels.addMember(actor, id, (await readJson(c)).memberId);
    return c.json(chat(actor, id));
  });
  routes.delete("/chats/:id/members/:memberId", c => {
    const actor = c.get("actorId"), id = c.req.param("id");
    channels.removeMember(actor, id, c.req.param("memberId"));
    return c.json(chat(actor, id));
  });
  routes.put("/chats/:id/note", jsonBody, async c => {
    const actor = c.get("actorId"), id = c.req.param("id");
    channels.setNote(actor, id, (await readJson(c)).text);
    return c.json(chat(actor, id));
  });
  routes.post("/chats/:id/read", jsonBody, async c => c.json({ readSequence: channels.markRead(c.get("actorId"), c.req.param("id"), (await readJson(c)).sequence) }));
  return routes;
}
