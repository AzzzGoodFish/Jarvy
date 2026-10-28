import { Readable } from "node:stream";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { chatView, messageView } from "../views/chat.js";
import { byteRange, downloadType } from "../views/download.js";
import { ATTACHMENT_MAX_BYTES } from "../../../contract/chat.js";
import { tooLarge } from "../../service/chat/attachments.js";

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
  routes.post("/:id/attachments", async c => {
    let name: string;
    try { name = decodeURIComponent(c.req.header("x-file-name") ?? ""); }
    catch { throw new HTTPException(400, { message: "Invalid filename" }); }
    // A declared size past the limit is refused before a byte is read; the stream is counted either way (A66).
    const declared = Number(c.req.header("content-length") ?? NaN);
    if (declared > ATTACHMENT_MAX_BYTES) throw tooLarge();
    const body = c.req.raw.body;
    if (!body) throw new HTTPException(400, { message: "Empty attachment" });
    const mime = (c.req.header("content-type") ?? "application/octet-stream").slice(0, 100);
    return c.json(await chats.attachments.upload(c.get("actorId"), c.req.param("id"), name, mime, idle(body, c.req.raw.signal)), 201);
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
    const file = chats.attachments.find(c.get("actorId"), c.req.param("id"));
    if (!file) throw new HTTPException(404, { message: "Attachment not found" });
    const size = file.size, range = byteRange(c.req.header("Range"), size);
    const headers = { "Content-Type": downloadType(file.mimeType), "Accept-Ranges": "bytes",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` };
    if (range === "unsatisfiable") return c.body(null, 416, { ...headers, "Content-Range": `bytes */${size}` });
    if (!range) return c.body(web(chats.attachments.stream(file)), 200, { ...headers, "Content-Length": String(size) });
    return c.body(web(chats.attachments.stream(file, range)), 206,
      { ...headers, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${size}` });
  });
  routes.get("/:id/run", c => {
    const file = chats.attachments.find(c.get("actorId"), c.req.param("id"));
    if (!file) throw new HTTPException(404, { message: "Attachment not found" });
    if (!/\.html?$/i.test(file.name) && file.mimeType !== "text/html") throw new HTTPException(415, { message: "Only HTML attachments can run" });
    c.set("sandboxedDocument", true);
    return c.body(web(chats.attachments.stream(file)), 200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(file.size) });
  });
  routes.delete("/:id", async c => {
    if (!await chats.attachments.removePending(c.get("actorId"), c.req.param("id"))) throw new HTTPException(404, { message: "Pending attachment not found" });
    return c.json({ ok: true });
  });
  return routes;
}

/** An upload's body, cut off when nothing arrives for a minute: the server has no overall time limit on a request,
 * so a file of gigabytes can take as long as it needs while it keeps moving (A66). */
async function* idle(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal.aborted) throw new HTTPException(400, { message: "Upload cancelled" });
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HTTPException(408, { message: "Upload stalled" })), UPLOAD_IDLE_MS); });
      try {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) return;
        yield value;
      } finally { clearTimeout(timer); }
    }
  } finally { void reader.cancel().catch(() => undefined); }
}
const UPLOAD_IDLE_MS = 60_000;
/** A Node stream as the web stream a response body takes. */
const web = (stream: Readable) => Readable.toWeb(stream) as ReadableStream<Uint8Array>;
