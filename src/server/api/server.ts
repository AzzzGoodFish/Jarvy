import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createServer as createListener, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { ApiServices } from "./context.js";
import { createHttpApp } from "./app.js";

export interface JarvyServer {
  listen(port: number, host: string): Promise<void>;
  /** Stops listening and drops every open connection. */
  close(): void;
}
/** This machine's own addresses, looked up again at most once a minute: a tool here that uses the LAN address still
 * talks to Jarvy from this machine. */
let own = { at: 0, addresses: new Set<string>() };
function fromThisMachine(address = ""): boolean {
  const plain = address.replace(/^::ffff:/, "");
  if (/^127\./.test(plain) || plain === "::1") return true;
  if (Date.now() - own.at > 60_000) own = { at: Date.now(), addresses: new Set(Object.values(networkInterfaces()).flatMap(list => (list ?? []).map(item => item.address))) };
  return own.addresses.has(plain);
}

/** Jarvy's HTTP server. With a certificate (A51) one port serves both protocols: the first byte of a connection tells
 * a TLS handshake (0x16) from plain HTTP. Plain HTTP from another machine is redirected to HTTPS at the same address
 * unless the owner allows it; from this machine, by any of its addresses, it is always served. */
export function createJarvyServer(services: ApiServices, webRoot: string, tls: { key: string; cert: string } | null): JarvyServer {
  const app = createHttpApp(services, webRoot);
  // HTTP/1 bindings are supplied by node:http. Keep Pi's global Fetch objects untouched.
  const handle = getRequestListener((request, bindings) => app.fetch(request, bindings as HttpBindings), { overrideGlobalObjects: false });
  const plain = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (tls && !fromThisMachine(request.socket.remoteAddress) && !services.connection.allowHttp()) {
      response.writeHead(308, { Location: `https://${request.headers.host ?? ""}${request.url ?? "/"}`, "Cache-Control": "no-store" }).end();
      return;
    }
    void handle(request, response);
  });
  if (!tls) return {
    listen: (port, host) => new Promise((resolve, reject) => { plain.once("error", reject); plain.listen(port, host, () => { plain.off("error", reject); resolve(); }); }),
    close: () => { plain.close(); plain.closeAllConnections(); },
  };
  const secure = createSecureServer({ key: tls.key, cert: tls.cert }, (request, response) => void handle(request, response));
  const front = createListener({ pauseOnConnect: true }, (socket: Socket) => {
    socket.on("error", () => socket.destroy());
    // A connection that never says anything (browsers open some ahead of time) is dropped after a while.
    socket.setTimeout(60_000, () => socket.destroy());
    socket.once("readable", () => {
      const head = socket.read(1) as Buffer | null;
      if (!head) { socket.destroy(); return; }
      socket.setTimeout(0); socket.unshift(head);
      // Both servers take what is already buffered first: node:http through its data listener, TLS by feeding it in.
      (head[0] === 0x16 ? secure : plain).emit("connection", socket);
    });
  });
  return {
    listen: (port, host) => new Promise((resolve, reject) => { front.once("error", reject); front.listen(port, host, () => { front.off("error", reject); resolve(); }); }),
    close: () => { front.close(); plain.closeAllConnections(); secure.closeAllConnections(); },
  };
}
