import { spawn, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import WebSocket from "ws";
import { DEVICE_DAEMON_PATH, DEVICE_PATH, DEVICE_PROTOCOL, type DeviceToJarvy, type JarvyToDevice } from "../contract/device.js";
import { spawnWinPty, type WinPtyProcess } from "./win-pty.js";

/** The part of the desktop client that connects a computer to Jarvy (A96), with no window: the Electron app runs it in
 * its main process, and `connector.mjs` runs it from a terminal. It keeps one WebSocket open to Jarvy, reconnecting
 * when it drops; Jarvy asks it to run its pi-env daemon, which it got from that same Jarvy, and it joins the daemon's
 * standard input and output to the WebSocket. Nothing else on the computer is reachable from Jarvy. */

export interface Trust {
  /** Jarvy's root certificate (PEM), accepted once by its fingerprint; null for plain HTTP to this machine or the LAN. */
  ca: string | null;
}
export type Status =
  | { state: "connecting" }
  | { state: "online"; name: string; working: string[] }
  | { state: "offline"; reason: string; retryIn: number }
  | { state: "unpaired" } | { state: "outdated"; protocol: number };

/** A small HTTPS (or HTTP) request that trusts only Jarvy's root, when there is one. */
export function call(server: string, trust: Trust, method: string, path: string, options: { headers?: Record<string, string>; body?: string; raw?: boolean } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const url = new URL(path, server), secure = url.protocol === "https:";
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(url, { method, headers: { ...(options.body ? { "Content-Type": "application/json", Origin: url.origin } : {}), ...options.headers },
      ...(secure ? trust.ca ? { ca: trust.ca } : { rejectUnauthorized: false } : {}) }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("Jarvy didn't answer in 30 seconds")));
    req.end(options.body);
  });
}

/** Jarvy's root certificate, fetched without trusting anything yet, with its SHA-256 fingerprint for the person to
 * compare with Settings › 网络 in Jarvy. Null when Jarvy serves no HTTPS. */
export async function fetchRoot(server: string): Promise<{ pem: string; fingerprint: string } | null> {
  const res = await call(server, { ca: null }, "GET", "/api/connection/root.crt");
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Jarvy answered ${res.status} for its root certificate`);
  const cert = new X509Certificate(res.body);
  return { pem: cert.toString(), fingerprint: cert.fingerprint256 };
}

/** The shells this computer has for a Bot's commands: Git Bash on Windows (not WSL's bash), bash elsewhere, and
 * PowerShell 7 before Windows PowerShell. */
export function findShells(): { bash?: string; powershell?: string } {
  const windows = process.platform === "win32", dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const onPath = (names: string[]) => { for (const dir of dirs) for (const name of names) { const path = join(dir, name); if (existsSync(path)) return path; } return undefined; };
  let bash: string | undefined, powershell: string | undefined;
  if (windows) {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")].filter((dir): dir is string => !!dir);
    bash = roots.map(root => join(root, "Git", "bin", "bash.exe")).find(existsSync);
    // Git installed elsewhere: its bash.exe is beside git.exe's folder (<Git>\cmd\git.exe → <Git>\bin\bash.exe).
    // A bash.exe on PATH is usually WSL's (System32), which isn't Git Bash.
    if (!bash) { const git = onPath(["git.exe"]); const beside = git && join(git, "..", "..", "bin", "bash.exe"); if (beside && existsSync(beside)) bash = beside; }
    if (!bash) { const found = onPath(["bash.exe"]); if (found && /git/i.test(found)) bash = found; }
    powershell = onPath(["pwsh.exe"]) ?? [process.env.ProgramFiles && join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")].find((path): path is string => !!path && existsSync(path))
      ?? onPath(["powershell.exe"]) ?? [process.env.SystemRoot && join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")].find((path): path is string => !!path && existsSync(path));
  } else {
    bash = process.env.SHELL?.endsWith("bash") ? process.env.SHELL : ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"].find(existsSync);
    powershell = onPath(["pwsh"]);
  }
  return { ...(bash ? { bash } : {}), ...(powershell ? { powershell } : {}) };
}

/** The pi-env daemon of the Jarvy it connects to, kept by its SHA-256 under `cache`, downloaded once per version. */
export async function daemon(server: string, trust: Trust, token: string, cache: string, have?: { path: string; sha256: string }): Promise<{ path: string; sha256: string }> {
  const query = `?platform=${process.platform}&arch=${process.arch}`, name = process.platform === "win32" ? "pi-env.exe" : "pi-env";
  const known = have && existsSync(have.path) ? have : undefined;
  const res = await call(server, trust, "GET", `${DEVICE_DAEMON_PATH}${query}`, { headers: { Authorization: `Device ${token}`, ...(known ? { "If-None-Match": `"${known.sha256}"` } : {}) } });
  if (res.status === 304 && known) return known;
  if (res.status !== 200) throw new Error(res.status === 403 ? "Jarvy doesn't know this computer any more" : `Jarvy answered ${res.status} for the daemon: ${res.body.toString().slice(0, 200)}`);
  const sha256 = createHash("sha256").update(res.body).digest("hex");
  if (sha256 !== res.headers["x-daemon-sha256"]) throw new Error("The daemon Jarvy sent doesn't match its checksum");
  const folder = join(cache, sha256.slice(0, 16)), path = join(folder, name);
  if (existsSync(path) && createHash("sha256").update(await readFile(path)).digest("hex") === sha256) return { path, sha256 };
  await mkdir(folder, { recursive: true });
  await writeFile(`${path}.part`, res.body);
  await chmod(`${path}.part`, 0o755);
  await rename(`${path}.part`, path);
  return { path, sha256 };
}

export interface ConnectorOptions {
  server: string; token: string; trust: Trust;
  /** Where downloaded daemons are kept. */
  cache: string;
  client: string; capabilities?: string[];
  onStatus?(status: Status): void;
  log?(text: string): void;
}

/** Keeps the computer connected until `stop()`. A drop is retried after 1 s, doubling up to 30 s; an unpaired
 * computer, or a Jarvy that speaks another protocol, stops it. */
export class Connector {
  private socket: WebSocket | null = null;
  private readonly daemons = new Map<number, { child: ChildProcess; bot: string }>();
  private readonly ptys = new Map<number, WinPtyProcess>();
  private stopped = false;
  private paused = false;
  private wait = 1000;
  private timer: NodeJS.Timeout | null = null;
  private name = "";
  /** The daemon fetched last, checked again (without its body when unchanged) on every connection. */
  private program: { path: string; sha256: string } | undefined;
  constructor(private readonly options: ConnectorOptions) {}

  start(): void { this.stopped = false; void this.connect(); }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.killAll();
    this.socket?.close(1000, "stopped");
  }
  /** The person pauses Bots' work here: running commands stop, and Jarvy is told to send none until resumed. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.killAll();
    this.send({ t: "state", paused });
    this.report();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.options.onStatus?.({ state: "connecting" });
    let program: string;
    try { this.program = await daemon(this.options.server, this.options.trust, this.options.token, this.options.cache, this.program); program = this.program.path; }
    catch (error) { return this.retry(error instanceof Error ? error.message : String(error)); }
    const url = new URL(DEVICE_PATH, this.options.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: { Authorization: `Device ${this.options.token}` }, handshakeTimeout: 15_000, maxPayload: 64 * 2 ** 20,
      ...(url.protocol === "wss:" ? this.options.trust.ca ? { ca: this.options.trust.ca } : { rejectUnauthorized: false } : {}) });
    this.socket = socket;
    socket.on("open", () => {
      this.wait = 1000;
      const capabilities = [...new Set([...(this.options.capabilities ?? []), ...(process.platform === "win32" ? ["pty"] : [])])];
      this.send({ t: "hello", protocol: DEVICE_PROTOCOL, platform: process.platform, arch: process.arch, home: homedir(), hostname: hostname(),
        shells: findShells(), client: this.options.client, capabilities, paused: this.paused });
    });
    socket.on("message", (data: Buffer, binary: boolean) => {
      if (binary) {
        if (data.length < 4) return;
        const ch = data.readUInt32BE(0), body = data.subarray(4);
        const entry = this.daemons.get(ch);
        if (entry) { entry.child.stdin?.write(body); return; }
        this.ptys.get(ch)?.write(body);
        return;
      }
      let message: JarvyToDevice;
      try { message = JSON.parse(data.toString("utf8")) as JarvyToDevice; } catch { return; }
      if (message.t === "welcome") { this.name = message.name; this.report(); }
      else if (message.t === "error" && message.code === "protocol") { this.stopped = true; this.options.onStatus?.({ state: "outdated", protocol: message.protocol }); }
      else if (message.t === "open") this.run(program, message.ch, message.args, message.bot ?? "");
      else if (message.t === "pty_open") void this.runPty(message);
      else if (message.t === "pty_resize") this.ptys.get(message.ch)?.resize(message.cols, message.rows);
      else if (message.t === "close") this.kill(message.ch);
    });
    socket.on("unexpected-response", (_request, response) => {
      if (response.statusCode === 401) { this.stopped = true; this.options.onStatus?.({ state: "unpaired" }); }
      socket.terminate();
    });
    socket.on("close", (code: number) => {
      this.killAll();
      if (this.socket === socket) this.socket = null;
      if (code === 4003) { this.stopped = true; this.options.onStatus?.({ state: "unpaired" }); return; }
      if (code === 4001) { this.stopped = true; return; }
      if (code === 4000) { this.stopped = true; this.options.onStatus?.({ state: "offline", reason: "This computer connected again from another client", retryIn: 0 }); return; }
      this.retry(code === 1006 ? "The connection to Jarvy dropped" : `Jarvy closed the connection (${code})`);
    });
    socket.on("error", (error: Error) => this.options.log?.(`connection: ${error.message}`));
  }
  private retry(reason: string): void {
    if (this.stopped) return;
    this.options.onStatus?.({ state: "offline", reason, retryIn: this.wait });
    this.timer = setTimeout(() => void this.connect(), this.wait);
    this.wait = Math.min(this.wait * 2, 30_000);
  }
  /** Runs the daemon for one channel, in the person's own session, with their environment. */
  private run(program: string, ch: number, args: string[], bot: string): void {
    if (this.paused) { this.send({ t: "exit", ch, code: null, error: "paused" }); return; }
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: homedir() });
    this.daemons.set(ch, { child, bot });
    this.report();
    child.stdout.on("data", (chunk: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(ch); this.socket?.send(Buffer.concat([head, chunk])); });
    child.stderr.on("data", (chunk: Buffer) => this.options.log?.(`daemon: ${chunk.toString().trim()}`));
    child.stdin.on("error", () => {});
    const done = (code: number | null, error?: string) => {
      if (!this.daemons.delete(ch)) return;
      this.send({ t: "exit", ch, code, ...(error ? { error } : {}) });
      this.report();
    };
    child.on("exit", code => done(code));
    child.on("error", error => done(null, error.message));
  }
  /** Opens an interactive ConPTY shell on Windows (A103), piped directly over its WebSocket channel. */
  private async runPty(message: Extract<JarvyToDevice, { t: "pty_open" }>): Promise<void> {
    if (this.paused) { this.send({ t: "exit", ch: message.ch, code: null, error: "paused" }); return; }
    if (process.platform !== "win32") { this.send({ t: "exit", ch: message.ch, code: null, error: "unsupported" }); return; }
    const shells = findShells();
    const argv = message.argv?.length ? message.argv : shells.powershell ? [shells.powershell, "-NoLogo"] : shells.bash ? [shells.bash, "--login", "-i"] : ["cmd.exe"];
    try {
      const pty = await spawnWinPty({
        cache: this.options.cache,
        cwd: message.cwd || homedir(),
        argv,
        cols: message.cols,
        rows: message.rows,
        env: message.env,
        onData: chunk => {
          if (this.socket?.readyState !== WebSocket.OPEN) return;
          const head = Buffer.alloc(4); head.writeUInt32BE(message.ch);
          this.socket.send(Buffer.concat([head, chunk]));
        },
        onExit: (code, error) => {
          if (!this.ptys.delete(message.ch)) return;
          this.send({ t: "exit", ch: message.ch, code, ...(error ? { error } : {}) });
        },
        onLog: text => this.options.log?.(text),
      });
      if (this.stopped || this.paused || this.socket?.readyState !== WebSocket.OPEN) { pty.kill(); return; }
      this.ptys.set(message.ch, pty);
    } catch (error) {
      this.send({ t: "exit", ch: message.ch, code: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  private kill(ch: number): void {
    const entry = this.daemons.get(ch);
    if (entry) { entry.child.stdin?.end(); entry.child.kill(); }
    const pty = this.ptys.get(ch);
    if (pty) { this.ptys.delete(ch); pty.kill(); }
  }
  private killAll(): void {
    for (const ch of [...this.daemons.keys()]) this.kill(ch);
    for (const ch of [...this.ptys.keys()]) this.kill(ch);
  }
  private send(message: DeviceToJarvy): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private report(): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.name) return;
    this.options.onStatus?.({ state: "online", name: this.name, working: [...new Set([...this.daemons.values()].map(entry => entry.bot).filter(Boolean))] });
  }
}

