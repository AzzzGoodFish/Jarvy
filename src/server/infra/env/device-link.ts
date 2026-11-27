import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { WorkEnvironment } from "../../shared/environment.js";
import type { PtyExit, PtyHandle, PtyOpenOptions } from "../../shared/terminal.js";
import { overDurable } from "./durable.js";
import { DEVICE_PATH, DEVICE_PROTOCOL, type SandboxNodeInfo } from "../../../contract/device.js";
import { currentJarvyVersion } from "../../shared/version.js";

/* Jarvy opens a channel each time pi-env starts its daemon on a computer (A96, A108); the client runs the daemon
 * (on the host or inside a remote sandbox container via `docker exec`) and joins its I/O to the WebSocket channel. */

export interface DeviceHello {
  platform: string; arch: string; home: string; hostname?: string;
  shells: { bash?: string; powershell?: string };
  client: string; capabilities: string[];
  paused: boolean;
  sandbox?: SandboxNodeInfo;
}

type Control =
  | ({ t: "hello"; protocol: number } & Partial<DeviceHello>)
  | { t: "state"; paused?: boolean; sandbox?: SandboxNodeInfo }
  | { t: "exit"; ch: number; code?: number | null; error?: string }
  | { t: "rpc_result"; id: string; ok: boolean; result?: unknown; error?: string }
  | { t: "tcp_ready"; ch: number };

export interface DeviceHooks {
  authenticate(tokenHash: string): { id: string; name: string } | null;
  hello(id: string, hello: DeviceHello): void;
  presence(id: string, online: boolean): void;
  sandboxState?(id: string, sandbox: SandboxNodeInfo | undefined): void;
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

interface NativePtyEntry {
  onData: (chunk: Buffer) => void;
  finish: (exit: PtyExit) => void;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TcpTunnelEntry {
  stream: Duplex;
  ready: () => void;
  fail: (error: Error) => void;
}

/** One client's connection, carrying pi-env channels, native PTYs, compute RPCs, and TCP tunnels. */
class Link {
  readonly channels = new Map<number, Socket>();
  readonly ptys = new Map<number, NativePtyEntry>();
  readonly rpcs = new Map<string, PendingRpc>();
  readonly tunnels = new Map<number, TcpTunnelEntry>();
  capabilities = new Set<string>();
  sandbox: SandboxNodeInfo | undefined;
  private next = 1;
  paused = false;
  alive = true;
  constructor(readonly id: string, readonly name: string, readonly socket: WebSocket) {}

  open(args: string[], bot: string, relay: Socket, container?: string, sandboxKind?: "container" | "vm"): number {
    const ch = this.next++;
    this.channels.set(ch, relay);
    this.socket.send(JSON.stringify({ t: "open", ch, args, bot, ...(container ? { container } : {}), ...(sandboxKind ? { sandboxKind } : {}) }));
    relay.on("data", (chunk: Buffer) => { if (this.socket.readyState === this.socket.OPEN) this.socket.send(frame(ch, chunk)); });
    const done = () => {
      if (!this.channels.delete(ch)) return;
      if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify({ t: "close", ch }));
    };
    relay.on("close", done);
    relay.on("error", () => relay.destroy());
    return ch;
  }

  openPty(options: PtyOpenOptions): PtyHandle {
    const ch = this.next++;
    let settled = false;
    let resolveExit!: (exit: PtyExit) => void;
    const exited = new Promise<PtyExit>(resolve => { resolveExit = resolve; });
    const finish = (exit: PtyExit) => {
      if (settled) return;
      settled = true;
      this.ptys.delete(ch);
      resolveExit(exit);
    };
    this.ptys.set(ch, { onData: options.onData, finish });
    this.socket.send(JSON.stringify({
      t: "pty_open", ch, cols: options.cols, rows: options.rows, cwd: options.cwd,
      ...(options.argv ? { argv: [...options.argv] } : {}),
      ...(options.env ? { env: options.env } : {}),
    }));
    return {
      write: data => {
        if (settled || this.socket.readyState !== this.socket.OPEN) return;
        const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
        this.socket.send(frame(ch, bytes));
      },
      resize: (cols, rows) => {
        if (settled || this.socket.readyState !== this.socket.OPEN) return;
        this.socket.send(JSON.stringify({ t: "pty_resize", ch, cols, rows }));
      },
      close: () => {
        if (settled) return;
        if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify({ t: "close", ch }));
        finish({ exitCode: null, reason: "closed" });
      },
      exited,
    };
  }

  callRpc<T>(op: string, params?: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    if (this.socket.readyState !== this.socket.OPEN) return Promise.reject(new Error("Compute node is not connected"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcs.delete(id);
        reject(new Error(`Compute RPC ${op} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref();
      this.rpcs.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ t: "rpc", id, op, ...(params ? { params } : {}) }));
    });
  }

  rpcResult(id: string, ok: boolean, result: unknown, error?: string): void {
    const pending = this.rpcs.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.rpcs.delete(id);
    if (ok) pending.resolve(result);
    else pending.reject(new Error(error || "Compute RPC failed"));
  }

  /** Opens a raw TCP tunnel through this client to `host:port` (for remote container `ports.publish`, A108). */
  openTcpTunnel(host: string, port: number): Duplex {
    const ch = this.next++;
    let connected = false;
    let closed = false;
    const closeRemote = () => {
      if (closed) return;
      closed = true;
      this.tunnels.delete(ch);
      if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify({ t: "close", ch }));
    };
    const stream = new Duplex({
      read() {},
      write: (chunk: Buffer, _enc, cb) => {
        if (closed || this.socket.readyState !== this.socket.OPEN) { cb(new Error("Tunnel closed")); return; }
        this.socket.send(frame(ch, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        cb();
      },
      final: cb => { closeRemote(); cb(); },
      destroy: (err, cb) => { closeRemote(); cb(err); },
    });
    const entry: TcpTunnelEntry = {
      stream,
      ready: () => { if (!connected && !closed) { connected = true; stream.emit("connect"); } },
      fail: error => { if (!closed) { closed = true; this.tunnels.delete(ch); stream.destroy(error); } },
    };
    this.tunnels.set(ch, entry);
    if (this.socket.readyState !== this.socket.OPEN) {
      queueMicrotask(() => entry.fail(new Error("Compute node disconnected")));
    } else {
      this.socket.send(JSON.stringify({ t: "tcp_open", ch, host, port }));
    }
    return stream;
  }

  tcpReady(ch: number): void { this.tunnels.get(ch)?.ready(); }

  data(ch: number, bytes: Buffer): void {
    const relay = this.channels.get(ch);
    if (relay) { relay.write(bytes); return; }
    const pty = this.ptys.get(ch);
    if (pty) { pty.onData(bytes); return; }
    const tunnel = this.tunnels.get(ch);
    if (tunnel) tunnel.stream.push(bytes);
  }

  exit(ch: number, code: number | null = null, error?: string): void {
    const relay = this.channels.get(ch);
    if (relay) { this.channels.delete(ch); relay.end(); return; }
    const pty = this.ptys.get(ch);
    if (pty) { pty.finish({ exitCode: code, ...(error ? { reason: error } : {}) }); return; }
    const tunnel = this.tunnels.get(ch);
    if (tunnel) {
      this.tunnels.delete(ch);
      if (error) tunnel.stream.destroy(new Error(error));
      else tunnel.stream.push(null);
    }
  }

  drop(): void {
    for (const relay of this.channels.values()) relay.destroy();
    this.channels.clear();
    for (const pty of [...this.ptys.values()]) pty.finish({ exitCode: null, reason: "disconnected" });
    this.ptys.clear();
    for (const pending of this.rpcs.values()) { clearTimeout(pending.timer); pending.reject(new Error("Compute node disconnected")); }
    this.rpcs.clear();
    for (const tunnel of [...this.tunnels.values()]) tunnel.fail(new Error("Compute node disconnected"));
    this.tunnels.clear();
  }
}

const frame = (ch: number, bytes: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(ch); return Buffer.concat([head, bytes]); };

const RELAY = `const net=require("node:net");const [path,key,device,bot,container,sandboxKind,...args]=process.argv.slice(1);
const s=net.connect(path,()=>{s.write(JSON.stringify({key,device,bot,...(container?{container}:{}),...(sandboxKind?{sandboxKind}:{}),args})+"\\n");process.stdin.pipe(s);s.pipe(process.stdout);});
s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0));process.stdin.on("end",()=>s.end());`;

export class DeviceLinks {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 64 * 2 ** 20 });
  private readonly links = new Map<string, Link>();
  private readonly wsAuthFails = new Map<string, { fails: number[]; blockedUntil: number }>();
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
  hasCapability(id: string, capability: string): boolean { return !!this.links.get(id)?.capabilities.has(capability); }
  sandboxInfo(id: string): SandboxNodeInfo | undefined { return this.links.get(id)?.sandbox; }

  /** Lists all online, non-paused compute nodes capable of hosting remote Docker containers or KVM VMs (A108, A110). */
  sandboxNodes(kind: "container" | "vm" = "container"): Array<{ id: string; name: string; sandbox: SandboxNodeInfo }> {
    const out: Array<{ id: string; name: string; sandbox: SandboxNodeInfo }> = [];
    for (const link of this.links.values()) {
      if (link.paused || !link.sandbox) continue;
      if (kind === "vm" ? !link.sandbox.vm : !link.sandbox.docker) continue;
      out.push({ id: link.id, name: link.name, sandbox: link.sandbox });
    }
    return out;
  }

  callRpc<T>(id: string, op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const link = this.links.get(id);
    if (!link || link.paused) return Promise.reject(new Error("Compute node is offline or paused"));
    return link.callRpc<T>(op, params, timeoutMs);
  }

  openTcpTunnel(id: string, host: string, port: number): Duplex {
    const link = this.links.get(id);
    if (!link || link.paused) {
      const dead = new Duplex({ read() {}, write(_c, _e, cb) { cb(new Error("Compute node offline")); } });
      queueMicrotask(() => dead.destroy(new Error("Compute node offline")));
      return dead;
    }
    return link.openTcpTunnel(host, port);
  }

  openConnection(id: string, onLog?: (text: string) => void, container = "", sandboxKind: "container" | "vm" | "" = ""): Connection {
    return new Connection({ command: [process.execPath, "-e", RELAY, this.path, this.key, id, "", container, sandboxKind], ...(onLog ? { onLog } : {}) });
  }
  openTerminalConnection(id: string, onLog?: (text: string) => void, container = "", sandboxKind: "container" | "vm" | "" = ""): Connection {
    return this.openConnection(id, onLog, container, sandboxKind);
  }
  openNativePty(id: string, options: PtyOpenOptions): PtyHandle | null {
    const link = this.links.get(id);
    if (!link || link.paused) return null;
    return link.openPty(options);
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, remoteIp?: string, onAuthFailed?: (ip: string, reason: string) => void): boolean {
    if (new URL(request.url ?? "/", "http://jarvy").pathname !== DEVICE_PATH) return false;
    const ip = (remoteIp ?? request.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    const now = Date.now();
    const record = this.wsAuthFails.get(ip);
    if (record && record.blockedUntil > now) {
      onAuthFailed?.(ip, "ws_rate_limited");
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return true;
    }
    const auth = /^Device\s+(\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    const device = auth ? this.hooks.authenticate(tokenHash(auth)) : null;
    if (!device) {
      const fails = (record?.fails ?? []).filter(ts => now - ts < 5 * 60_000);
      fails.push(now);
      const blockedUntil = fails.length >= 15 ? now + 15 * 60_000 : 0;
      if (this.wsAuthFails.size >= 4000) {
        const oldest = this.wsAuthFails.keys().next().value;
        if (oldest !== undefined) this.wsAuthFails.delete(oldest);
      }
      this.wsAuthFails.set(ip, { fails, blockedUntil });
      onAuthFailed?.(ip, blockedUntil > now ? "ws_auth_blocked" : "ws_auth_failed");
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return true;
    }
    if (record) this.wsAuthFails.delete(ip);
    this.server.handleUpgrade(request, socket, head, ws => this.accept(device, ws));
    return true;
  }

  environment(id: string, bot: string, directory: string, temp: string, onLog?: (text: string) => void): WorkEnvironment {
    const connection = new Connection({ command: [process.execPath, "-e", RELAY, this.path, this.key, id, bot, "", ""], ...(onLog ? { onLog } : {}) });
    return overDurable(id, "device", new RemoteExecutionEnv({ connection, id: `device:${id}`, cwd: directory }), {
      passEnv: false, temp, close: () => connection.close() });
  }

  /** Opens a `WorkEnvironment` inside a remote sandbox container or KVM VM on compute node `id` (A108, A110). */
  remoteContainerEnvironment(id: string, envId: string, container: string, bot: string, cwd: string, onLog?: (text: string) => void, sandboxKind: "container" | "vm" = "container"): WorkEnvironment {
    const connection = new Connection({ command: [process.execPath, "-e", RELAY, this.path, this.key, id, bot, container, sandboxKind], ...(onLog ? { onLog } : {}) });
    return overDurable(envId, "computer", new RemoteExecutionEnv({ connection, id: `remote-computer:${id}:${container}`, cwd }), {
      passEnv: false, close: () => connection.close() });
  }

  disconnect(id: string): void { this.links.get(id)?.socket.close(4003, "unpaired"); }
  close(): void {
    clearInterval(this.beat);
    const links = [...this.links.values()];
    this.links.clear();
    for (const link of links) { link.drop(); link.socket.close(1001, "Jarvy is stopping"); }
    this.server.close();
    this.relays.close();
    rmSync(this.folder, { recursive: true, force: true });
  }

  private accept(device: { id: string; name: string }, ws: WebSocket): void {
    let link: Link | null = null;
    const hello = setTimeout(() => ws.close(4002, "no hello"), 15_000);
    ws.on("pong", () => { if (link) link.alive = true; });
    ws.on("message", (data: RawData, binary: boolean) => {
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
        const info = describe(message);
        link = new Link(device.id, device.name, ws);
        link.paused = info.paused;
        link.capabilities = new Set(info.capabilities);
        link.sandbox = info.sandbox;
        this.links.set(device.id, link);
        this.hooks.hello(device.id, info);
        this.hooks.sandboxState?.(device.id, info.sandbox);
        ws.send(JSON.stringify({ t: "welcome", id: device.id, name: device.name, protocol: DEVICE_PROTOCOL, serverVersion: currentJarvyVersion() }));
        this.hooks.presence(device.id, true);
      } else if (!link) return;
      else if (message.t === "state") {
        link.paused = !!message.paused;
        if (message.sandbox !== undefined) { link.sandbox = message.sandbox; this.hooks.sandboxState?.(device.id, message.sandbox); }
        this.hooks.presence(device.id, true);
      }
      else if (message.t === "exit") link.exit(message.ch, message.code ?? null, message.error);
      else if (message.t === "rpc_result") link.rpcResult(message.id, message.ok, message.result, message.error);
      else if (message.t === "tcp_ready") link.tcpReady(message.ch);
    });
    ws.on("close", (code: number) => {
      clearTimeout(hello);
      if (link && code !== 1000 && code !== 1001) console.warn(`[devices] ${device.name}: connection closed (${code})`);
      if (!link) return;
      link.drop();
      if (this.links.get(device.id) === link) {
        this.links.delete(device.id);
        this.hooks.sandboxState?.(device.id, undefined);
        this.hooks.presence(device.id, false);
      }
    });
    ws.on("error", error => { console.warn(`[devices] ${device.name}: ${error.message}`); ws.terminate(); });
  }

  private relay(socket: Socket): void {
    let head = Buffer.alloc(0);
    const first = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(10);
      if (end < 0) { if (head.length > 64 * 1024) socket.destroy(); return; }
      socket.off("data", first);
      socket.pause();
      let request: { key?: string; device?: string; bot?: unknown; container?: unknown; sandboxKind?: unknown; args?: unknown };
      try { request = JSON.parse(head.subarray(0, end).toString("utf8")) as typeof request; } catch { socket.destroy(); return; }
      const link = typeof request.device === "string" ? this.links.get(request.device) : undefined;
      if (!same(request.key, this.key) || !link || link.paused || !Array.isArray(request.args) || !request.args.every(arg => typeof arg === "string")) { socket.destroy(); return; }
      const container = typeof request.container === "string" && request.container ? request.container : undefined;
      const sandboxKind = request.sandboxKind === "vm" ? "vm" : request.sandboxKind === "container" ? "container" : undefined;
      const ch = link.open(request.args as string[], typeof request.bot === "string" ? request.bot.slice(0, 100) : "", socket, container, sandboxKind);
      const rest = head.subarray(end + 1);
      if (rest.length) link.socket.send(frame(ch, rest));
      socket.resume();
    };
    socket.on("data", first);
    socket.on("error", () => socket.destroy());
  }

  private heartbeat(): void {
    for (const link of this.links.values()) {
      if (!link.alive) { link.socket.terminate(); continue; }
      link.alive = false;
      link.socket.ping();
    }
  }
}

function same(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function describe(message: Partial<DeviceHello>): DeviceHello {
  const string = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
  const shells = message.shells && typeof message.shells === "object" ? message.shells : {};
  const sb = message.sandbox && typeof message.sandbox === "object" ? message.sandbox : undefined;
  return {
    platform: string(message.platform, 30), arch: string(message.arch, 30), home: string(message.home, 500),
    ...(typeof message.hostname === "string" && message.hostname ? { hostname: string(message.hostname, 120) } : {}),
    shells: { ...(typeof shells.bash === "string" && shells.bash ? { bash: string(shells.bash, 500) } : {}),
      ...(typeof shells.powershell === "string" && shells.powershell ? { powershell: string(shells.powershell, 500) } : {}) },
    client: string(message.client, 60),
    capabilities: Array.isArray(message.capabilities) ? message.capabilities.filter((item): item is string => typeof item === "string").slice(0, 20) : [],
    paused: !!message.paused,
    ...(sb && typeof sb.docker === "boolean" ? {
      sandbox: {
        docker: sb.docker,
        ...(typeof sb.vm === "boolean" ? { vm: sb.vm } : {}),
        ...(typeof sb.vmReason === "string" && sb.vmReason ? { vmReason: string(sb.vmReason, 40) } : {}),
        ...(typeof sb.vmImage === "string" && sb.vmImage ? { vmImage: string(sb.vmImage, 120) } : {}),
        ...(typeof sb.activeVms === "number" ? { activeVms: Number(sb.activeVms) || 0 } : {}),
        cpus: Number(sb.cpus) || 0,
        memory: Number(sb.memory) || 0,
        image: string(sb.image, 120),
        activeContainers: Number(sb.activeContainers) || 0,
        maxContainers: Number(sb.maxContainers) || 0,
      },
    } : {}),
  };
}
