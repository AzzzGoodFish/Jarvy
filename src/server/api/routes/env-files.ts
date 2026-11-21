import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";

const UPLOAD_IDLE_MS = 60_000;
const disposition = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

/** Owner-authenticated routes for browsing, downloading, uploading and managing files in any work environment (A104). */
export function envFileRoutes(envFiles: ApiServices["envFiles"]) {
  const routes = new Hono<ApiEnv>();

  routes.get("/:id/files", async c => {
    const listing = await envFiles.list(c.req.param("id"), c.req.query("path") || undefined, c.req.raw.signal);
    return c.json(listing);
  });

  routes.get("/:id/files/download", async c => {
    const path = c.req.query("path") ?? "";
    const file = await envFiles.openDownload(c.req.param("id"), path, c.req.raw.signal);
    return c.body(file.stream, 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": disposition(file.name),
      "Content-Length": String(file.size),
      "Cache-Control": "no-store",
    });
  });

  routes.post("/:id/files/upload", async c => {
    let name: string;
    try { name = decodeURIComponent(c.req.header("x-file-name") ?? ""); }
    catch { throw new HTTPException(400, { message: "Invalid filename" }); }
    const dir = c.req.query("path") ?? "";
    const overwrite = c.req.query("overwrite") === "1";
    const body = c.req.raw.body;
    const chunks: AsyncIterable<Uint8Array> = body ? idleStream(body, c.req.raw.signal) : emptyStream();
    const result = await envFiles.upload(c.req.param("id"), dir, name, chunks, {
      overwrite,
      signal: c.req.raw.signal,
    });
    return c.json(result, 201);
  });

  routes.post("/:id/files/mkdir", jsonBody, async c => {
    const input = await readJson(c);
    const entry = await envFiles.mkdir(c.req.param("id"), String(input.path ?? ""), String(input.name ?? ""), c.req.raw.signal);
    return c.json(entry, 201);
  });

  routes.post("/:id/files/rename", jsonBody, async c => {
    const input = await readJson(c);
    const entry = await envFiles.rename(c.req.param("id"), String(input.path ?? ""), String(input.name ?? ""), c.req.raw.signal);
    return c.json(entry);
  });

  routes.delete("/:id/files", async c => {
    await envFiles.remove(c.req.param("id"), c.req.query("path") ?? "", c.req.raw.signal);
    return c.json({ ok: true });
  });

  return routes;
}

/** Cuts off a stalled upload after 60s without bytes while allowing arbitrarily large files over slow links (A66, A104). */
async function* idleStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal.aborted) throw new HTTPException(400, { message: "Upload cancelled" });
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HTTPException(408, { message: "Upload stalled" })), UPLOAD_IDLE_MS);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) return;
        yield value;
      } finally { clearTimeout(timer); }
    }
  } finally { void reader.cancel().catch(() => undefined); }
}

async function* emptyStream(): AsyncGenerator<Uint8Array> {
  // 0-byte files are valid uploads.
}
