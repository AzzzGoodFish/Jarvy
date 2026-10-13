import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, attachmentBody, readJson } from "../middleware/body.js";
import { chatView, messageView } from "../views/chat.js";
import { byteRange, downloadType } from "../views/download.js";

export function chatRoutes({ chats, bots }: Pick<ApiServices, "chats" | "bots">) {
  const routes = new Hono<ApiEnv>();
  const view = (chat: ReturnType<typeof chats.createDm>) => chatView(chat, id => chats.member(id));
  routes.get("/", c => c.json({ chats: chats.list(c.get("actorId")).map(view) }));
  routes.post("/", jsonBody, async c => {
    const chat = chats.createDm(c.get("actorId"), await readJson(c));
    return c.json(view(chat), 201);
  });
  routes.get("/:id/messages", c => {
    // ?tail=N: the newest N; ?before=S&limit=N: the N before sequence S. Both say whether older ones exist.
    const before = c.req.query("before"), tail = c.req.query("tail");
    if (before !== undefined || tail !== undefined) {
      const page = chats.readBefore(c.get("actorId"), c.req.param("id"), before === undefined ? null : Number(before), Number(tail ?? c.req.query("limit") ?? 50));
      return c.json({ messages: page.messages.map(messageView), hasOlder: page.hasOlder });
    }
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 1000);
    const messages = chats.read(c.get("actorId"), c.req.param("id"), after, limit);
    return c.json({ messages: messages.map(messageView), nextSequence: messages.at(-1)?.sequence ?? after, hasMore: messages.length === limit });
  });
  routes.post("/:id/messages", jsonBody, async c => {
    const message = await chats.send(c.get("actorId"), c.req.param("id"), await readJson(c));
    return c.json(messageView(message), 201);
  });
  routes.post("/:id/questions/:messageId", jsonBody, async c => {
    const message = chats.questions.respond(c.get("actorId"), c.req.param("id"), c.req.param("messageId"), await readJson(c));
    return c.json(messageView(message));
  });
  routes.post("/:id/attachments", attachmentBody, async c => {
    let name: string;
    try { name = decodeURIComponent(c.req.header("x-file-name") ?? ""); }
    catch { throw new HTTPException(400, { message: "Invalid filename" }); }
    const data = Buffer.from(await c.req.arrayBuffer());
    if (!data.length) throw new HTTPException(400, { message: "Empty attachment" });
    const mime = (c.req.header("content-type") ?? "application/octet-stream").slice(0, 100);
    return c.json(chats.upload(c.get("actorId"), c.req.param("id"), name, mime, data), 201);
  });
  routes.delete("/:id", async c => {
    const id = c.req.param("id");
    if (!await chats.delete(c.get("actorId"), id)) throw new HTTPException(404, { message: "Chat not found" });
    await bots.chatDeleted(id);
    return c.json({ ok: true });
  });
  return routes;
}

export function attachmentRoutes(chats: ApiServices["chats"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/:id", c => {
    // Access first: someone who cannot read the attachment learns nothing, not even its size.
    const attachment = chats.download(c.get("actorId"), c.req.param("id"));
    if (!attachment) throw new HTTPException(404, { message: "Attachment not found" });
    const size = attachment.data.length, range = byteRange(c.req.header("Range"), size);
    const headers = { "Content-Type": downloadType(attachment.file.mimeType), "Accept-Ranges": "bytes",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.file.name)}` };
    if (range === "unsatisfiable") return c.body(null, 416, { ...headers, "Content-Range": `bytes */${size}` });
    if (!range) return c.body(new Uint8Array(attachment.data), 200, { ...headers, "Content-Length": String(size) });
    return c.body(new Uint8Array(attachment.data.subarray(range.start, range.end + 1)), 206,
      { ...headers, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${size}` });
  });
  routes.get("/:id/run", c => {
    const attachment = chats.download(c.get("actorId"), c.req.param("id"));
    if (!attachment) throw new HTTPException(404, { message: "Attachment not found" });
    const { name, mimeType } = attachment.file;
    if (!/\.html?$/i.test(name) && mimeType !== "text/html") throw new HTTPException(415, { message: "Only HTML attachments can run" });
    c.set("sandboxedDocument", true);
    return c.body(new Uint8Array(attachment.data), 200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(attachment.data.length) });
  });
  routes.delete("/:id", c => {
    if (!chats.removePendingAttachment(c.get("actorId"), c.req.param("id"))) throw new HTTPException(404, { message: "Pending attachment not found" });
    return c.json({ ok: true });
  });
  return routes;
}
