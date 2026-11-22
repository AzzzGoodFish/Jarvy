import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { TERMINAL_WS_PREFIX, TERMINAL_WS_SUFFIX } from "../../../contract/terminal.js";
import type { ApiEnv, ApiServices } from "../context.js";
import { jsonBody, readJson } from "../middleware/body.js";
import { sessionCookieName } from "./account.js";
import { encrypted } from "../server.js";

/** REST routes for persistent interactive terminals (A103). */
export function terminalRoutes(terminals: ApiServices["terminals"]) {
  const routes = new Hono<ApiEnv>();
  routes.get("/", c => {
    const environmentId = c.req.query("environmentId");
    return c.json({ terminals: terminals.list(environmentId || undefined) });
  });
  routes.post("/", jsonBody, async c => {
    const input = await readJson(c);
    const session = await terminals.create(String(input.environmentId ?? ""), {
      name: input.name,
      cols: input.cols,
      rows: input.rows,
      shell: input.shell,
      cwd: input.cwd,
    });
    return c.json(session, 201);
  });
  routes.patch("/:id", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(terminals.rename(c.req.param("id"), input.name));
  });
  routes.post("/:id/restart", jsonBody, async c => {
    const input = await readJson(c);
    return c.json(await terminals.restart(c.req.param("id"), { cols: input.cols, rows: input.rows }));
  });
  routes.delete("/:id", c => {
    terminals.close(c.req.param("id"));
    return c.json({ ok: true });
  });
  return routes;
}

const wsServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 2 ** 20 });

/** Parses a cookie value from the HTTP `Cookie` header without pulling in extra parsers. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return undefined;
}

/** Handles WebSocket upgrades for `/api/terminals/:id/ws` (A103), enforcing both owner session cookie
 * authentication and same-origin Origin checks to prevent cross-site WebSocket hijacking. */
export function upgradeTerminal(request: IncomingMessage, socket: Duplex, head: Buffer, services: ApiServices): boolean {
  const pathname = new URL(request.url ?? "/", "http://jarvy").pathname;
  if (!pathname.startsWith(TERMINAL_WS_PREFIX) || !pathname.endsWith(TERMINAL_WS_SUFFIX)) return false;
  const id = pathname.slice(TERMINAL_WS_PREFIX.length, -TERMINAL_WS_SUFFIX.length);
  if (!id || id.includes("/")) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return true;
  }
  const origin = request.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === request.headers.host; } catch { /* untrusted origin */ }
    if (!sameOrigin) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return true;
    }
  }
  const cookieName = sessionCookieName(services.account.instance, encrypted(request));
  const token = readCookie(request.headers.cookie, cookieName);
  if (!services.account.authenticated(token)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return true;
  }
  if (!services.terminals.has(id)) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return true;
  }
  wsServer.handleUpgrade(request, socket, head, ws => services.terminals.attach(id, ws));
  return true;
}
