import type { Store } from "../../infra/storage/store.js";
import type { PortRecord } from "../../infra/storage/port-repository.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { forward, forwardUpgrade, portFree, type ForwardPolicy } from "../../infra/net/proxy.js";
import type { PortState, PublishedPort } from "../../../contract/ports.js";
import type { Listening } from "../connection.js";
import { ValidationError } from "../../shared/errors.js";
import { RuntimeFault } from "../../shared/runtime.js";
import type { Computers } from "./computers.js";

const MAX_PER_BOT = 20;
/** Jarvy's session cookies, of this Jarvy and of others on the same host (browsers scope cookies by host, not port):
 * a Bot's service never gets them, and can't set one either. */
const SESSION_COOKIE = /^jarvy_session_/;
type Client = { address: string; secure: boolean };
const policy = (client: Client): ForwardPolicy => ({ cookie: name => !SESSION_COOKIE.test(name), setCookie: name => !SESSION_COOKIE.test(name), client });
const wildcard = (host: string) => host === "0.0.0.0" || host === "::";

/** Where a request to a published port goes: the Bot's running sandbox, or why it can't. */
export type PortTarget = { kind: "open"; botId: string; host: string; port: number } | { kind: "stopped" | "missing" };

/** Ports Bots publish from their sandboxes (A74). A Bot publishes one with ports.publish and gets a port of Jarvy's
 * for it, from the owner's range; the API layer listens there and forwards to the sandbox, letting in the owner's
 * browser and this Jarvy's other Bots. The owner sees and unpublishes them in Bot info. What changes here is told to
 * `onChange` listeners, so the listening follows. */
export class PublishedPorts {
  private readonly listeners = new Set<() => void>();
  /** Taking a port is one at a time, so two publishes don't pick the same free one. */
  private taking: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: Store, private readonly computers: Computers, private readonly listening: () => Listening | null) {}

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Rows changed elsewhere, such as a Bot deleted with its ports. */
  changed(): void { for (const listener of this.listeners) listener(); }
  /** Every published port, for the listening. */
  all(): PortRecord[] { return this.store.ports.all(); }

  /** A Bot's published ports with what each finds now. */
  async list(botId: string): Promise<PublishedPort[]> {
    const records = this.store.ports.list(botId);
    if (!records.length) return [];
    const states = await this.states(botId);
    return records.map(record => this.view(record, states(record.port)));
  }
  /** Publishes a port of the Bot's sandbox, or renames one it published, which keeps its link. */
  async publish(botId: string, input: { port: unknown; name: unknown; description: unknown }): Promise<PublishedPort> {
    if (!this.store.environments.computerOf(botId)) throw new RuntimeFault("computer_missing", "This Bot has no sandbox.", 404);
    const port = input.port;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new ValidationError("A port is 1-65535", "port_invalid");
    const name = text(input.name, "A name", 60), description = text(input.description, "A description", 300);
    const existing = this.store.ports.get(botId, port as number);
    if (!existing && this.store.ports.list(botId).length >= MAX_PER_BOT) throw new ValidationError(`At most ${MAX_PER_BOT} published ports a Bot`, "port_invalid");
    const record = await this.take(async () => {
      const hostPort = this.store.ports.get(botId, port as number)?.hostPort ?? await this.freePort();
      return this.store.ports.save({ botId, port: port as number, name, description, hostPort });
    });
    this.changed();
    return this.view(record, (await this.states(botId))(record.port));
  }
  unpublish(botId: string, port: number): void {
    if (!this.store.ports.remove(botId, port)) throw new ValidationError("That port isn't published", "port_missing");
    this.changed();
  }
  /** The sandbox is reset: what ran there is gone, and so are its links. */
  unpublishAll(botId: string): void { if (this.store.ports.removeAll(botId)) this.changed(); }
  /** A published port's own port was taken by another program while Jarvy was off: it moves to a free one. */
  async relocate(record: PortRecord): Promise<void> {
    await this.take(async () => this.store.ports.move(record.botId, record.port, await this.freePort()));
    this.changed();
  }

  /** Where a request to Jarvy's `hostPort` goes now. */
  async target(hostPort: number): Promise<PortTarget> {
    const record = this.store.ports.byHostPort(hostPort);
    if (!record) return { kind: "missing" };
    const host = await this.computers.address(record.botId);
    return host ? { kind: "open", botId: record.botId, host, port: record.port } : { kind: "stopped" };
  }
  /** Forwards a request the API layer let through to the sandbox; `failed` when nothing answers there. */
  forward(request: IncomingMessage, response: ServerResponse, to: { host: string; port: number }, client: Client, failed: (error: Error) => void): void {
    forward(request, response, to, policy(client), failed);
  }
  forwardUpgrade(request: IncomingMessage, socket: Socket, head: Buffer, to: { host: string; port: number }, client: Client, failed: (error: Error) => void): void {
    forwardUpgrade(request, socket, head, to, policy(client), failed);
  }
  /** The Bot whose sandbox a request came from, if it is one of this Jarvy's. */
  caller(address: string): Promise<string | null> { return this.computers.botAt(address); }

  /** Links to it: from other devices (or this machine, when Jarvy listens on it only), and from sandboxes. */
  links(hostPort: number): { urls: string[]; fromSandboxes: string | null } {
    const where = this.listening();
    if (!where) return { urls: [], fromSandboxes: null };
    const url = (scheme: string, host: string) => `${scheme}://${host.includes(":") ? `[${host}]` : host}:${hostPort}`;
    const urls = where.addresses.length ? where.addresses.map(host => url(where.https ? "https" : "http", host)) : [url("http", "localhost")];
    // Sandboxes reach this machine by name only where Jarvy listens on every address; plain HTTP is served to them.
    const fromSandboxes = wildcard(where.host) ? url("http", this.computers.hostName) : where.addresses[0] ? url("http", where.addresses[0]) : null;
    return { urls, fromSandboxes };
  }

  private take<T>(work: () => Promise<T>): Promise<T> {
    const done = this.taking.then(work, work);
    this.taking = done.catch(() => undefined);
    return done;
  }
  private view(record: PortRecord, state: PortState): PublishedPort {
    return { botId: record.botId, port: record.port, name: record.name, description: record.description, hostPort: record.hostPort,
      urls: this.links(record.hostPort).urls, state, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }
  private async states(botId: string): Promise<(port: number) => PortState> {
    try {
      const listening = await this.computers.listening(botId);
      if (!listening) return () => "stopped";
      return port => { const found = listening.get(port); return !found ? "idle" : found.loopbackOnly ? "local" : "live"; };
    } catch { return () => "unknown"; }
  }
  /** The first port of the range no published port has and nothing listens on, skipping Jarvy's own. */
  private async freePort(): Promise<number> {
    const where = this.listening();
    if (!where) throw new RuntimeFault("stopping", "Jarvy isn't listening yet.", 503);
    const taken = this.store.ports.hostPorts();
    for (let port = where.range.from; port <= where.range.to; port++) {
      if (port === where.port || taken.has(port)) continue;
      if (await portFree(where.host, port)) return port;
    }
    throw new ValidationError(`No free port left in ${where.range.from}-${where.range.to}`, "ports_exhausted", { from: where.range.from, to: where.range.to });
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new ValidationError(`${label} must be 1-${max} characters`, "port_invalid");
  return value.trim();
}
