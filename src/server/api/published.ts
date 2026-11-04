import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { ApiServices } from "./context.js";
import { dualProtocol, encrypted, redirectsToHttps, redirectToHttps, type JarvyServer } from "./server.js";
import { sessionCookieName } from "./routes/account.js";
import { portPage, type PortPage } from "./views/port-page.js";

type Services = Pick<ApiServices, "bots" | "account" | "connection">;
type Caller = { owner: true } | { bot: string } | "redirect" | null;
const STATUS: Record<PortPage, number> = { signin: 401, stopped: 503, unreachable: 502, missing: 404 };

function cookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** The ports Bots published (A74), each on a port of Jarvy's, served like Jarvy's own: both protocols on one port,
 * with its certificate. A request gets through when it comes from the owner's browser, signed in to this Jarvy, or
 * from one of this Jarvy's sandboxes, by its address; plain HTTP from another device goes to HTTPS as on Jarvy's
 * port. What may go and how it is forwarded is the service's; here are only the listening and the pages. The
 * listening follows the published ports: a change there opens or closes ports, one at a time. */
export class PublishedListeners {
  private readonly open = new Map<number, JarvyServer>();
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private closed = false;
  constructor(private readonly services: Services, private readonly tls: { key: string; cert: string } | null, private readonly host: string, private readonly jarvyPort: number) {}

  start(): void {
    this.unsubscribe = this.services.bots.ports.onChange(() => this.sync());
    this.sync();
  }
  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    for (const server of this.open.values()) server.close();
    this.open.clear();
  }
  private sync(): void {
    this.queue = this.queue.then(() => this.follow()).catch(error => console.error("[ports] listening failed", { error: (error as Error).message }));
  }
  private async follow(): Promise<void> {
    if (this.closed) return;
    const ports = this.services.bots.ports, records = ports.all(), wanted = new Set(records.map(record => record.hostPort));
    for (const [hostPort, server] of this.open) if (!wanted.has(hostPort)) { server.close(); this.open.delete(hostPort); }
    for (const record of records) {
      if (this.open.has(record.hostPort)) continue;
      const hostPort = record.hostPort;
      const server = dualProtocol(this.tls, (request, response) => void this.serve(hostPort, request, response).catch(() => response.destroy()),
        (request, socket, head) => void this.upgrade(hostPort, request, socket, head).catch(() => socket.destroy()));
      try { await server.listen(hostPort, this.host); this.open.set(hostPort, server); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") { console.error(`[ports] can't listen on ${hostPort}`, { error: (error as Error).message }); continue; }
        // Another program took it while Jarvy was off: the port moves, and the change brings us back here.
        console.warn(`[ports] ${hostPort} is taken by another program; moving ${record.name} to a free port`);
        await ports.relocate(record).catch(reason => console.error("[ports] no free port", { error: (reason as Error).message }));
      }
    }
  }

  /** Who is asking: the signed-in owner, one of this Jarvy's Bots, or no one (or someone to send to HTTPS first). */
  private async caller(request: IncomingMessage): Promise<Caller> {
    const { account, bots, connection } = this.services;
    if (account.authenticated(cookie(request, sessionCookieName(account.instance, encrypted(request))))) return { owner: true };
    const bot = await bots.ports.caller(request.socket.remoteAddress ?? "");
    if (bot) return { bot };
    return redirectsToHttps(request, this.tls, () => connection.allowHttp()) ? "redirect" : null;
  }
  private async serve(hostPort: number, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const caller = await this.caller(request);
    if (caller === "redirect") { redirectToHttps(request, response); return; }
    if (!caller) { this.page(request, response, "signin"); return; }
    const target = await this.services.bots.ports.target(hostPort);
    if (target.kind !== "open") { this.page(request, response, target.kind); return; }
    this.services.bots.ports.forward(request, response, target, this.client(request), () => this.page(request, response, "unreachable"));
  }
  private async upgrade(hostPort: number, request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const caller = await this.caller(request);
    if (!caller || caller === "redirect") { refuse("401 Unauthorized"); return; }
    const target = await this.services.bots.ports.target(hostPort);
    if (target.kind !== "open") { refuse(target.kind === "missing" ? "404 Not Found" : "503 Service Unavailable"); return; }
    this.services.bots.ports.forwardUpgrade(request, socket, head, target, this.client(request), () => refuse("502 Bad Gateway"));
  }
  private client(request: IncomingMessage) { return { address: request.socket.remoteAddress ?? "", secure: encrypted(request) }; }
  private page(request: IncomingMessage, response: ServerResponse, kind: PortPage): void {
    if (response.headersSent) { response.destroy(); return; }
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    const jarvyUrl = host ? `${encrypted(request) ? "https" : "http"}://${host}:${this.jarvyPort}/` : null;
    response.writeHead(STATUS[kind], { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer" });
    response.end(request.method === "HEAD" ? undefined : portPage(kind, request.headers["accept-language"], jarvyUrl));
  }
}
