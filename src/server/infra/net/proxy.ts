import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { connect, createServer, type Socket } from "node:net";

/** Where a request goes. */
export interface Upstream { host: string; port: number }
/** What a forward keeps from the caller and the service: `cookie` decides each cookie the caller sends, `setCookie`
 * each one the service sets; `client` is the caller's address and whether it came over TLS, as X-Forwarded-*. */
export interface ForwardPolicy {
  cookie(name: string): boolean;
  setCookie(name: string): boolean;
  client: { address: string; secure: boolean };
}

// Headers about one connection, not the request: the proxy has its own connections on each side.
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"]);

function cookies(header: string | undefined, keep: (name: string) => boolean): string | undefined {
  if (!header) return undefined;
  const kept = header.split(";").map(part => part.trim()).filter(part => part && keep(part.split("=")[0]!.trim()));
  return kept.length ? kept.join("; ") : undefined;
}
function requestHeaders(request: IncomingMessage, policy: ForwardPolicy, upgrade: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === "cookie" || name.startsWith("x-forwarded-")) continue;
    if (HOP.has(name) && !(upgrade && (name === "upgrade" || name === "connection"))) continue;
    headers[name] = value;
  }
  const cookie = cookies(request.headers.cookie, policy.cookie);
  if (cookie) headers.cookie = cookie;
  headers["x-forwarded-for"] = policy.client.address.replace(/^::ffff:/, "");
  headers["x-forwarded-proto"] = policy.client.secure ? "https" : "http";
  if (request.headers.host) headers["x-forwarded-host"] = request.headers.host;
  return headers;
}
function responseHeaders(headers: IncomingHttpHeaders, policy: ForwardPolicy): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP.has(name)) continue;
    if (name === "set-cookie") {
      const kept = (Array.isArray(value) ? value : [value]).filter(line => policy.setCookie(line.split("=")[0]!.trim()));
      if (kept.length) out[name] = kept;
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Forwards one HTTP request and streams the answer back. `failed` gets a connection error before anything was sent,
 * so the caller can answer instead; after that the response is cut off. */
export function forward(request: IncomingMessage, response: ServerResponse, upstream: Upstream, policy: ForwardPolicy, failed: (error: Error) => void): void {
  const outgoing = httpRequest({ host: upstream.host, port: upstream.port, method: request.method, path: request.url, headers: requestHeaders(request, policy, false) }, incoming => {
    response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, responseHeaders(incoming.headers, policy));
    incoming.pipe(response);
    incoming.on("error", () => response.destroy());
  });
  outgoing.on("error", error => { if (response.headersSent) response.destroy(); else failed(error); });
  response.on("close", () => { if (!response.writableFinished) outgoing.destroy(); });
  request.pipe(outgoing);
}

/** Forwards an upgrade (a WebSocket): the request goes over a new connection, then both sides are joined as they are.
 * `failed` gets a connection error; the caller answers on the socket. */
export function forwardUpgrade(request: IncomingMessage, socket: Socket, head: Buffer, upstream: Upstream, policy: ForwardPolicy, failed: (error: Error) => void): void {
  const target = connect(upstream.port, upstream.host);
  let joined = false;
  target.once("connect", () => {
    joined = true;
    const headers = requestHeaders(request, policy, true);
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    target.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on("error", error => { if (joined) socket.destroy(); else failed(error); });
  socket.on("error", () => target.destroy());
  socket.on("close", () => target.destroy());
  target.on("close", () => socket.destroy());
}

/** Whether nothing listens on `port` at `host` now, found by listening there for a moment. */
export function portFree(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
