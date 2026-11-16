import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { WorkEnvironment } from "../../shared/environment.js";
import { overDurable } from "./durable.js";
import { DEVICE_PATH, DEVICE_PROTOCOL } from "../../../contract/device.js";

/* Jarvy opens a channel each time pi-env starts its daemon on a computer (A96); the client runs the daemon it got
 * from Jarvy with the arguments it is given and joins its standard input and output to the channel. */

/** What a client says first: the computer it runs on, and the shells it found there. */
export interface DeviceHello {
  platform: string; arch: string; home: string; hostname?: string;
  shells: { bash?: string; powershell?: string };
  client: string; capabilities: string[];
  /** The person paused it in the client: it takes no new work until they resume. */
  paused: boolean;
}
type Control =
  | ({ t: "hello"; protocol: number } & Partial<DeviceHello>)
  | { t: "state"; paused?: boolean }
  | { t: "exit"; ch: number; code?: number | null; error?: string };

export interface DeviceHooks {
  /** The computer a token belongs to, by its SHA-256; null when it belongs to none. */
  authenticate(tokenHash: string): { id: string; name: string } | null;
  /** It connected and said what it is, or said it paused or resumed. */
  hello(id: string, hello: DeviceHello): void;
  /** Its connection came or went. */
  presence(id: string, online: boolean): void;
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

/** One client's connection, with the daemons running through it. */
class Link {
  readonly channels = new Map<number, Socket>();
  private next = 1;
  paused = false;
  alive = true;
  constructor(readonly id: string, readonly socket: WebSocket) {}
  open(args: string[], bot: string, relay: Socket): number {
    const ch = this.next++;
    this.channels.set(ch, relay);
    this.socket.send(JSON.stringify({ t: "open", ch, args, bot }));
    relay.on("data", (chunk: Buffer) => { if (this.socket.readyState === this.socket.OPEN) this.socket.send(frame(ch, chunk)); });
    const done = () => {
      if (!this.channels.delete(ch)) return;
      if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify({ t: "close", ch }));
    };
    relay.on("close", done);
    relay.on("error", () => relay.destroy());
    return ch;
  }
  data(ch: number, bytes: Buffer): void { this.channels.get(ch)?.write(bytes); }
  exit(ch: number): void { const relay = this.channels.get(ch); this.channels.delete(ch); relay?.end(); }
  drop(): void { for (const relay of this.channels.values()) relay.destroy(); this.channels.clear(); }
}

const frame = (ch: number, bytes: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(ch); return Buffer.concat([head, bytes]); };

/** pi-env starts its daemon with a command; for a computer that connected itself, the command is this small relay,
 * run by the same Node: it joins its standard input and output to Jarvy's local socket, which Jarvy joins to the
 * computer's WebSocket. pi-env adds the daemon's own arguments (`serve --token …`) at the end. */
const RELAY = `const net=require("node:net");const [path,key,device,bot,...args]=process.argv.slice(1);
const s=net.connect(path,()=>{s.write(JSON.stringify({key,device,bot,args})+"\\n");process.stdin.pipe(s);s.pipe(process.stdout);});
s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0));process.stdin.on("end",()=>s.end());`;

/** The computers connected now (A96): their WebSockets, and the local socket pi-env's relays reach them through. */
export class DeviceLinks {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 64 * 2 ** 20 });
  private readonly links = new Map<string, Link>();
  private readonly folder = mkdtempSync(join(tmpdir(), "jarvy-devices-"));
  private readonly path = join(this.folder, "relay.sock");
  private readonly key = randomBytes(16).toString("hex");
  private readonly relays: Server;
  private readonly beat: NodeJS.Timeout;

  constructor(private readonly hooks: DeviceHooks) {
    this.relays = createServer(socket => this.relay(socket));
    this.relays.listen(this.path);
    this.beat = setInterval(() => this.heartbeat(), 30_000);
    this.beat.unref();
  }
  online(id: string): boolean { return this.links.has(id); }
  paused(id: string): boolean { return !!this.links.get(id)?.paused; }

  /** An upgrade on Jarvy's port: the device path is this one's; anything else is left alone (false). */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (new URL(request.url ?? "/", "http://jarvy").pathname !== DEVICE_PATH) return false;
    const auth = /^Device\s+(\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    const device = auth ? this.hooks.authenticate(tokenHash(auth)) : null;
    if (!device) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return true; }
    this.server.handleUpgrade(request, socket, head, ws => this.accept(device, ws));
    return true;
  }
  /** The computer as a Bot's environment: pi-env over the relay, started again whenever it is lost. */
  environment(id: string, bot: string, directory: string, temp: string, onLog?: (text: string) => void): WorkEnvironment {
    const connection = new Connection({ command: [process.execPath, "-e", RELAY, this.path, this.key, id, bot], ...(onLog ? { onLog } : {}) });
    return overDurable(id, "device", new RemoteExecutionEnv({ connection, id: `device:${id}`, cwd: directory }), {
      passEnv: false, temp, close: () => connection.close() });
  }
  /** Ends a computer's connection: it was unpaired. */
  disconnect(id: string): void { this.links.get(id)?.socket.close(4003, "unpaired"); }
  close(): void {
    clearInterval(this.beat);
    for (const link of this.links.values()) link.socket.close(1001, "Jarvy is stopping");
    this.server.close();
    this.relays.close();
    rmSync(this.folder, { recursive: true, force: true });
  }

  private accept(device: { id: string; name: string }, ws: WebSocket): void {
    let link: Link | null = null;
    const hello = setTimeout(() => ws.close(4002, "no hello"), 15_000);
    ws.on("pong", () => { if (link) link.alive = true; });
    ws.on("message", (data: RawData, binary: boolean) => {
      // Anything from the client shows it is there: under a long output its pong can wait behind the data.
      if (link) link.alive = true;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      if (binary) { if (link && bytes.length >= 4) link.data(bytes.readUInt32BE(0), bytes.subarray(4)); return; }
      let message: Control;
      try { message = JSON.parse(bytes.toString("utf8")) as Control; } catch { return; }
      if (message.t === "hello") {
        clearTimeout(hello);
        if (message.protocol !== DEVICE_PROTOCOL) { ws.send(JSON.stringify({ t: "error", code: "protocol", protocol: DEVICE_PROTOCOL })); ws.close(4001, "protocol"); return; }
        const previous = this.links.get(device.id);
        if (previous) { previous.drop(); previous.socket.close(4000, "replaced"); }
        link = new Link(device.id, ws);
        link.paused = !!message.paused;
        this.links.set(device.id, link);
        this.hooks.hello(device.id, describe(message));
        ws.send(JSON.stringify({ t: "welcome", id: device.id, name: device.name, protocol: DEVICE_PROTOCOL }));
        this.hooks.presence(device.id, true);
      } else if (!link) return;
      else if (message.t === "state") { link.paused = !!message.paused; this.hooks.presence(device.id, true); }
      else if (message.t === "exit") link.exit(message.ch);
    });
    ws.on("close", (code: number) => {
      clearTimeout(hello);
      if (link && code !== 1000 && code !== 1001) console.warn(`[devices] ${device.name}: connection closed (${code})`);
      if (!link) return;
      link.drop();
      if (this.links.get(device.id) === link) { this.links.delete(device.id); this.hooks.presence(device.id, false); }
    });
    ws.on("error", error => { console.warn(`[devices] ${device.name}: ${error.message}`); ws.terminate(); });
  }
  /** A relay pi-env started: its first line says which computer, and the daemon's arguments. */
  private relay(socket: Socket): void {
    let head = Buffer.alloc(0);
    const first = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(10);
      if (end < 0) { if (head.length > 64 * 1024) socket.destroy(); return; }
      socket.off("data", first);
      socket.pause();
      let request: { key?: string; device?: string; bot?: unknown; args?: unknown };
      try { request = JSON.parse(head.subarray(0, end).toString("utf8")) as typeof request; } catch { socket.destroy(); return; }
      const link = typeof request.device === "string" ? this.links.get(request.device) : undefined;
      if (!same(request.key, this.key) || !link || link.paused || !Array.isArray(request.args) || !request.args.every(arg => typeof arg === "string")) { socket.destroy(); return; }
      const ch = link.open(request.args as string[], typeof request.bot === "string" ? request.bot.slice(0, 100) : "", socket), rest = head.subarray(end + 1);
      if (rest.length) link.socket.send(frame(ch, rest));
      socket.resume();
    };
    socket.on("data", first);
    socket.on("error", () => socket.destroy());
  }
  private heartbeat(): void {
    for (const link of this.links.values()) {
      if (!link.alive) { console.warn(`[devices] ${link.id}: no answer for 30 s, disconnected`); link.socket.terminate(); continue; }
      link.alive = false;
      link.socket.ping();
    }
  }
}

function same(a: unknown, b: string): boolean {
  return typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
const short = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
function describe(message: Partial<DeviceHello>): DeviceHello {
  const shells = (message.shells ?? {}) as Record<string, unknown>;
  return { platform: short(message.platform, 20), arch: short(message.arch, 20), home: short(message.home, 1000), hostname: short(message.hostname, 100),
    shells: { ...(shells.bash ? { bash: short(shells.bash, 1000) } : {}), ...(shells.powershell ? { powershell: short(shells.powershell, 1000) } : {}) },
    client: short(message.client, 40), capabilities: Array.isArray(message.capabilities) ? message.capabilities.filter((item): item is string => typeof item === "string").slice(0, 20).map(item => item.slice(0, 40)) : [],
    paused: !!message.paused };
}
