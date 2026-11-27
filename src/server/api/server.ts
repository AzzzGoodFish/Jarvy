import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createServer as createListener, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { ApiServices } from "./context.js";
import { createHttpApp } from "./app.js";
import { clientIpFromIncoming, normalizeIp } from "./middleware/rate-limit.js";
import { upgradeTerminal } from "./routes/terminals.js";

export interface JarvyServer {
  listen(port: number, host: string): Promise<void>;
  /** Stops accepting new TCP connections while keeping in-flight responses and WS close frames alive (A114). */
  stopAccepting(): void;
  /** Stops listening and drops every open connection. */
  close(): void;
}

export interface ServerOptions {
  /** Drop non-TLS connections immediately on the listening port (`--tls-only`, A112). */
  tlsOnly?: boolean;
  /** Disable serving static web assets on this listener (`--no-web`, A112). */
  noWeb?: boolean;
  /** Trust X-Forwarded-For / X-Real-IP from loopback/LAN reverse proxies (`--trust-proxy`, A112). */
  trustProxy?: boolean;
  /** Returns true while the server is draining for shutdown/restart (A114). */
  isDraining?: () => boolean;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
}

const DEFAULT_MAX_CONNECTIONS = 512;
const DEFAULT_MAX_PER_IP = 64;
const SAFE_HOST_RE = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;

/** This machine's own addresses, looked up again at most once a minute: a tool here that uses the LAN address still
 * talks to Jarvy from this machine. */
let own = { at: 0, addresses: new Set<string>() };
export function fromThisMachine(address = ""): boolean {
  const plain = address.replace(/^::ffff:/, "");
  if (/^127\./.test(plain) || plain === "::1") return true;
  if (Date.now() - own.at > 60_000) own = { at: Date.now(), addresses: new Set(Object.values(networkInterfaces()).flatMap(list => (list ?? []).map(item => item.address))) };
  return own.addresses.has(plain);
}

type Upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => void;
/** One port for both protocols (A51): with a certificate the first byte of a connection tells a TLS handshake (0x16)
 * from plain HTTP, and each goes to its server; without one it is plain HTTP only. When `tlsOnly` is true (A112),
 * non-TLS connections are dropped immediately without any plaintext reply. */
export function dualProtocol(
  tls: { key: string; cert: string } | null,
  serve: (request: IncomingMessage, response: ServerResponse) => void,
  upgrade?: Upgrade,
  options: Pick<ServerOptions, "tlsOnly" | "maxConnections" | "maxConnectionsPerIp"> = {},
): JarvyServer {
  // No overall limit on how long a request may take: an upload of gigabytes needs as long as the link takes, and its
  // route cuts it off when it stops moving instead (A66). Headers and keep-alive idle windows are tightened (A112).
  const httpOptions = { requestTimeout: 0, headersTimeout: 30_000, keepAliveTimeout: 30_000 };
  const plain = createServer(httpOptions, serve);
  if (upgrade) plain.on("upgrade", upgrade);

  const maxTotal = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxPerIp = options.maxConnectionsPerIp ?? DEFAULT_MAX_PER_IP;
  const sockets = new Set<Socket>();
  const byIp = new Map<string, number>();

  const track = (socket: Socket): boolean => {
    const ip = normalizeIp(socket.remoteAddress);
    const local = fromThisMachine(ip);
    const ipCount = byIp.get(ip) ?? 0;
    if (sockets.size >= maxTotal || (!local && ipCount >= maxPerIp)) {
      socket.destroy();
      return false;
    }
    sockets.add(socket);
    byIp.set(ip, ipCount + 1);
    socket.once("close", () => {
      sockets.delete(socket);
      const cur = (byIp.get(ip) ?? 1) - 1;
      if (cur <= 0) byIp.delete(ip); else byIp.set(ip, cur);
    });
    return true;
  };
  const drop = () => { for (const socket of sockets) socket.destroy(); sockets.clear(); byIp.clear(); };

  if (!tls) {
    plain.on("connection", socket => { track(socket); });
    const stopAccepting = () => { if (plain.listening) plain.close(); };
    return {
      listen: (port, host) => new Promise((resolve, reject) => { plain.once("error", reject); plain.listen(port, host, () => { plain.off("error", reject); resolve(); }); }),
      stopAccepting,
      close: () => { stopAccepting(); drop(); },
    };
  }
  const secure = createSecureServer({ ...httpOptions, key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" }, serve);
  if (upgrade) secure.on("upgrade", upgrade);
  const front = createListener({ pauseOnConnect: true }, (socket: Socket) => {
    if (!track(socket)) return;
    socket.on("error", () => socket.destroy());
    // A connection that never says anything (browsers open some ahead of time) is dropped after a while.
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once("readable", () => {
      const head = socket.read(1) as Buffer | null;
      if (!head) { socket.destroy(); return; }
      socket.setTimeout(0);
      // In --tls-only mode, silently drop non-TLS connections (first byte != 0x16 TLS ClientHello).
      if (options.tlsOnly && head[0] !== 0x16) { socket.destroy(); return; }
      socket.unshift(head);
      // Both servers take what is already buffered first: node:http through its data listener, TLS by feeding it in.
      (head[0] === 0x16 ? secure : plain).emit("connection", socket);
    });
  });
  const stopAccepting = () => { if (front.listening) front.close(); };
  return {
    listen: (port, host) => new Promise((resolve, reject) => { front.once("error", reject); front.listen(port, host, () => { front.off("error", reject); resolve(); }); }),
    stopAccepting,
    close: () => { stopAccepting(); drop(); },
  };
}
export const encrypted = (request: IncomingMessage) => !!(request.socket as { encrypted?: boolean }).encrypted;
/** Plain HTTP from another machine goes to HTTPS at the same address, unless the owner allows it; from this machine,
 * by any of its addresses, it is always served. */
export function redirectsToHttps(request: IncomingMessage, tls: unknown, allowHttp: () => boolean): boolean {
  return !!tls && !encrypted(request) && !fromThisMachine(request.socket.remoteAddress) && !allowHttp();
}
export function redirectToHttps(request: IncomingMessage, response: ServerResponse): void {
  const host = request.headers.host ?? "";
  if (!SAFE_HOST_RE.test(host)) {
    response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Invalid Host header");
    return;
  }
  const path = request.url && request.url.startsWith("/") && !request.url.startsWith("//") ? request.url : "/";
  response.writeHead(308, { Location: `https://${host}${path}`, "Cache-Control": "no-store" }).end();
}

/** Jarvy's HTTP server, on one port for both protocols (A51), with public transport hardening and optional `--no-web` / `--tls-only` (A112). */
export function createJarvyServer(
  services: ApiServices,
  webRoot: string | null,
  tls: { key: string; cert: string } | null,
  options: ServerOptions = {},
): JarvyServer {
  const app = createHttpApp(services, webRoot, { noWeb: options.noWeb, ...(options.isDraining ? { isDraining: options.isDraining } : {}) });
  const trustProxy = Boolean(options.trustProxy);
  // HTTP/1 bindings are supplied by node:http. Keep Pi's global Fetch objects untouched.
  const handle = getRequestListener((request, bindings) => app.fetch(request, bindings as HttpBindings), { overrideGlobalObjects: false });
  return dualProtocol(tls, (request, response) => {
    if (redirectsToHttps(request, tls, () => services.connection.allowHttp())) { redirectToHttps(request, response); return; }
    void handle(request, response);
  }, (request, socket, head) => {
    if (options.isDraining?.()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // A computer's client connecting itself (A96), or an interactive terminal WebSocket (A103): over HTTPS from another machine, as the web is.
    if (redirectsToHttps(request, tls, () => services.connection.allowHttp())) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    const ip = clientIpFromIncoming(request, trustProxy);
    if (services.bots.devices.upgrade(request, socket, head, ip, (failIp, reason) => services.account.audit(reason, failIp, "WS /api/devices/connect"))) return;
    if (upgradeTerminal(request, socket, head, services)) return;
    socket.destroy();
  }, options);
}
