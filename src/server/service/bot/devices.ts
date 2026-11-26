import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { DeviceLinks, newToken, tokenHash, type DeviceHello } from "../../infra/env/device-link.js";
import { daemonFor } from "../../infra/env/device-daemon.js";
import { openDeviceFs } from "../../infra/env/env-fs.js";
import { openDevicePty } from "../../infra/env/terminal.js";
import type { Store } from "../../infra/storage/store.js";
import { ChatError } from "../../shared/chat.js";
import type { EnvironmentRecord, ExecOptions, WorkEnvironment } from "../../shared/environment.js";
import type { EnvironmentFs } from "../../shared/env-files.js";
import type { PtyHandle, PtyOpenOptions, PtyShell } from "../../shared/terminal.js";
import type { Device, DeviceShell } from "../../../contract/environment.js";
import { fromWindows, toWindows, windowsLike } from "./device-paths.js";

const SHELLS: DeviceShell[] = ["bash", "powershell"];

/** Computers the desktop client connected to Jarvy (A96). The client signs in as the owner and registers the computer
 * it runs on; from then on the computer connects itself with its own token, and Jarvy never reaches out to it. It is
 * an environment the owner grants to Bots like an SSH machine; a Bot's commands there run in the shell the owner chose
 * (Git Bash or PowerShell on Windows), in the person's own desktop session. */
export class Devices {
  private readonly links: DeviceLinks;
  private onNodeOffline?: (id: string) => void;
  constructor(private readonly store: Store, private readonly changed: () => void = () => {}) {
    this.links = new DeviceLinks({
      authenticate: hash => { const record = this.store.environments.deviceByToken(hash); return record ? { id: record.id, name: record.name } : null; },
      hello: (id, hello) => this.reported(id, hello),
      presence: (id, online) => {
        if (!online) { this.store.environments.updateDevice(id, { spec: { seenAt: String(Date.now()) } }); this.onNodeOffline?.(id); }
        this.changed();
      },
      sandboxState: (_id, _sandbox) => this.changed(),
    });
  }
  /** Exposes underlying WebSocket link hub for `ComputePool` remote sandbox scheduling (A108). */
  get deviceLinks(): DeviceLinks { return this.links; }
  setNodeOfflineHandler(handler: (id: string) => void): void { this.onNodeOffline = handler; }
  list(): Device[] { return this.store.environments.devices().map(record => this.view(record)); }
  get(id: string): Device { return this.view(this.need(id)); }
  /** The client registers the computer it runs on, signed in as the owner: the token comes back once, and only its
   * hash is kept. The computer connects with it and says what it is. */
  register(input: { name?: unknown }): { device: Device; token: string } {
    const token = newToken(), name = this.freeName(text(input.name, 40) || "电脑");
    const record = this.store.environments.addDevice({ name, directory: "", tokenHash: tokenHash(token), spec: { shell: "auto" } });
    this.changed();
    return { device: this.view(record), token };
  }
  update(id: string, input: { name?: unknown; description?: unknown; directory?: unknown; shell?: unknown }): Device {
    const record = this.need(id);
    const name = input.name === undefined ? undefined : text(input.name, 40);
    if (name !== undefined && !name) throw new ChatError(400, "A name is needed");
    if (name !== undefined && name !== record.name) this.freeName(name);
    if (input.shell !== undefined && input.shell !== "auto" && !SHELLS.includes(input.shell as DeviceShell)) throw new ChatError(400, "shell must be auto, bash or powershell");
    const directory = input.directory === undefined ? undefined : this.directoryIn(record, input.directory);
    this.store.environments.updateDevice(id, { ...(name !== undefined ? { name } : {}), ...(directory !== undefined ? { directory } : {}),
      ...(input.description !== undefined ? { description: text(input.description, 2000) } : {}),
      ...(input.shell !== undefined ? { spec: { shell: input.shell as string } } : {}) });
    this.changed();
    return this.get(id);
  }
  /** Unpairs it: the token stops working and the connection ends. Returns the Bots that were working there. */
  remove(id: string): string[] {
    this.need(id);
    const moved = this.store.environments.dropDevice(id);
    this.links.disconnect(id);
    this.changed();
    return moved;
  }
  /** An upgrade on Jarvy's port that is a computer connecting; false for any other. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean { return this.links.upgrade(request, socket, head); }
  /** The pi-env daemon for a computer's system, for its client to run: only to a computer with a valid token. */
  daemon(token: string | undefined, platform: string, arch: string): { open: () => NodeJS.ReadableStream; sha256: string; size: number } {
    if (!token || !this.store.environments.deviceByToken(tokenHash(token))) throw new ChatError(403, "Not a registered computer");
    const daemon = daemonFor(platform, arch);
    if (!daemon || !existsSync(daemon.path)) throw new ChatError(404, `No pi-env daemon for ${platform} ${arch}`);
    return { open: () => createReadStream(daemon.path), sha256: daemon.sha256, size: daemon.size };
  }
  online(id: string): boolean { return this.links.online(id) && !this.links.paused(id); }
  /** Verifies that a connected computer is online and not paused (A104). */
  verifyOnline(id: string): void {
    if (!this.online(id)) throw new ChatError(409, this.offline(id), "device_offline");
  }
  /** Opens a dedicated file-browser `EnvironmentFs` on a connected computer (A104). */
  openFs(record: EnvironmentRecord): EnvironmentFs {
    this.verifyOnline(record.id);
    const windows = record.spec.platform === "win32";
    const norm = (value: string) => windows ? toWindows(value).replaceAll("/", "\\") : value;
    const home = norm(this.home(record));
    const cwd = norm(this.directory(record));
    return openDeviceFs(this.links, record.id, cwd, home, windows ? "\\" : "/", text => console.error(`[device-fs ${record.name}] ${text.trim()}`));
  }
  /** Opens an interactive PTY on a connected computer (A103): pi-env PTY on Linux/macOS, ConPTY on Windows. */
  async openPty(record: EnvironmentRecord, options: PtyOpenOptions): Promise<{ pty: PtyHandle; cwd: string; shell?: PtyShell }> {
    if (!this.online(record.id)) throw new ChatError(409, this.offline(record.id), "device_offline");
    const platform = record.spec.platform ?? "";
    const windows = platform === "win32";
    if (windows && !this.links.hasCapability(record.id, "pty")) {
      throw new ChatError(409, "Update the Jarvy client on this Windows computer to open interactive terminals", "terminal_unsupported");
    }
    const rawDir = options.cwd ? this.terminalCwd(record, options.cwd) : this.directory(record);
    const cwd = windows ? toWindows(rawDir).replaceAll("/", "\\") : rawDir;
    const requested = options.shell;
    const chosen = record.spec.shell;
    const fallback = activeShell(record);
    let argv: string[] | undefined;
    let resolvedShell: PtyShell | undefined;
    if (windows) {
      const target = requested ?? fallback ?? "cmd";
      if (target === "bash") {
        if (!record.spec.shellBash) throw new ChatError(400, "Git Bash is not installed on this computer");
        argv = [record.spec.shellBash, "--login", "-i"];
        resolvedShell = "bash";
      } else if (target === "powershell") {
        argv = [record.spec.shellPowershell ?? "powershell.exe", "-NoLogo"];
        resolvedShell = "powershell";
      } else {
        argv = ["cmd.exe"];
        resolvedShell = "cmd";
      }
    } else {
      if (requested === "cmd") throw new ChatError(400, "Command Prompt is only available on Windows");
      if (requested === "powershell" || (!requested && chosen === "powershell")) {
        if (!record.spec.shellPowershell) throw new ChatError(400, "PowerShell is not installed on this computer");
        argv = [record.spec.shellPowershell, "-NoLogo"];
        resolvedShell = "powershell";
      } else if (requested === "bash" || (!requested && chosen === "bash")) {
        if (record.spec.shellBash) argv = [record.spec.shellBash, "-l"];
        resolvedShell = "bash";
      } else if (fallback) {
        resolvedShell = fallback;
      }
    }
    const pty = await openDevicePty(this.links, record.id, platform, { ...options, cwd, ...(argv ? { argv } : {}) },
      text => console.error(`[device-pty ${record.name}] ${text.trim()}`));
    return { pty, cwd, ...(resolvedShell ? { shell: resolvedShell } : {}) };
  }
  /** The command-line client (A96), built beside Jarvy's own server bundle; null when running from the sources. */
  connector(): Buffer | null {
    const path = fileURLToPath(new URL("./connector.mjs", import.meta.url));
    return existsSync(path) ? readFileSync(path) : null;
  }

  /** The computer as a Bot's environment. On Windows, paths are shown as Git Bash writes them (`/c/Users/…`) and turned
   * back on the way there. Commands run in its shell; while it is offline or paused, every call says so. */
  environment(record: EnvironmentRecord, botId: string): WorkEnvironment {
    const windows = record.spec.platform === "win32", outward = (path: string) => windows ? toWindows(path) : path;
    const home = this.home(record), temp = windows ? `${home}/AppData/Local/Jarvy/bots/${botId}` : `${home}/.cache/jarvy/${botId}`;
    const env = this.links.environment(record.id, this.store.bots.get(botId)?.name ?? "", outward(this.directory(record)), outward(temp),
      text => console.error(`[device ${record.name}] ${text.trim()}`));
    const ready = () => { if (!this.online(record.id)) throw new Error(this.offline(record.id)); };
    const shell = () => activeShell(this.need(record.id));
    const exec = async (command: string | readonly string[], options: ExecOptions) => {
      ready();
      const cwd = outward(options.cwd);
      if (typeof command !== "string") return env.exec(command, { ...options, cwd });
      // Bash by the path the client found: on Windows the daemon's own lookup (`which bash`) finds WSL's bash.exe in
      // System32 before Git Bash.
      const bash = this.need(record.id).spec.shellBash;
      if (shell() !== "powershell") return windows && bash ? env.exec([bash, "-c", command], { ...options, cwd }) : env.exec(command, { ...options, cwd });
      const program = this.need(record.id).spec.shellPowershell ?? "powershell.exe";
      const script = `${outward(temp)}/command-${randomBytes(6).toString("hex")}.ps1`;
      await env.writeFile(script, `\uFEFF${powershellScript(command, Object.keys(options.secrets ?? {}))}`);
      try { return await env.exec([program, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { ...options, cwd }); }
      finally { await env.exec(windows ? ["cmd.exe", "/d", "/c", "del", "/q", script.replaceAll("/", "\\")] : ["rm", "-f", script], { cwd, onData: () => {} }).catch(() => {}); }
    };
    const at = <T>(work: (path: string) => Promise<T>) => (path: string) => { ready(); return work(outward(path)); };
    return {
      id: env.id, kind: "device", local: false, cwd: windows ? fromWindows(env.cwd) : env.cwd, temp: windows ? fromWindows(temp) : temp,
      exec,
      readFile: at(path => env.readFile(path)),
      head: (path, bytes) => { ready(); return env.head(outward(path), bytes); },
      readRange: (path, offset, length) => { ready(); return env.readRange(outward(path), offset, length); },
      writeFile: (path, content) => { ready(); return env.writeFile(outward(path), content); },
      appendFile: (path, content) => { ready(); return env.appendFile(outward(path), content); },
      mkdir: at(path => env.mkdir(path)),
      exists: at(path => env.exists(path)),
      fileSize: at(path => env.fileSize(path)),
      ...(windows ? { normalize: (path: string) => windowsLike(path) ? fromWindows(path) : path } : {}),
      close: () => env.close(),
    };
  }
  /** What a Bot is told when it switches there. */
  about(record: EnvironmentRecord, botId: string): string {
    const windows = record.spec.platform === "win32", shell = activeShell(record), home = this.home(record);
    const temp = windows ? `${fromWindows(home)}/AppData/Local/Jarvy/bots/${botId}` : `${home}/.cache/jarvy/${botId}`;
    const system = windows ? "Windows" : record.spec.platform === "darwin" ? "macOS" : "Linux";
    const shellLine = !shell ? " It has no shell Jarvy can run commands in (Git Bash or PowerShell), so bash fails there; ask your owner to install Git for Windows."
      : shell === "powershell" ? ` Your bash tool runs PowerShell there (${record.spec.shellPowershell ?? "powershell.exe"}): write PowerShell, not bash, and put secret placeholders inside double quotes.`
      : windows ? " Your bash tool runs Git Bash there; PowerShell is at hand as powershell -Command '…'." : "";
    const paths = windows ? ` File tools take paths as Git Bash writes them, such as ${fromWindows(home)}/Desktop, or as C:\\Users\\…; programs started from PowerShell see the Windows form.` : "";
    return `Your owner's ${system} computer "${record.name}", connected through the Jarvy desktop client: your tools run there as the person signed in, in their own desktop session, and reach their files and programs. Work in your directory, leave other files alone unless the task needs them, and say in your reply what you changed there.${shellLine}${paths} Files from the chat and long command outputs go in ${temp}. While the computer is offline or the person paused the client, your tools there fail; switch back to your sandbox for other work.`;
  }
  /** environments.list's fields for it. */
  describe(record: EnvironmentRecord): Record<string, unknown> {
    const shell = activeShell(record);
    return { computer: `${record.spec.platform === "win32" ? "Windows" : record.spec.platform === "darwin" ? "macOS" : "Linux"}${record.spec.hostname ? ` (${record.spec.hostname})` : ""}`,
      state: !this.links.online(record.id) ? "offline" : this.links.paused(record.id) ? "paused" : "online", ...(shell ? { shell } : {}),
      ...(record.description ? { description: record.description } : {}) };
  }
  /** Where its tools start, as the Bot sees it. */
  place(record: EnvironmentRecord): string { const directory = this.directory(record); return record.spec.platform === "win32" ? fromWindows(directory) : directory; }
  close(): void { this.links.close(); }

  private reported(id: string, hello: DeviceHello): void {
    const record = this.need(id);
    this.store.environments.updateDevice(id, { spec: { platform: hello.platform, arch: hello.arch, home: hello.home, hostname: hello.hostname ?? "", client: hello.client,
      capabilities: hello.capabilities.join(","), shellBash: hello.shells.bash ?? null, shellPowershell: hello.shells.powershell ?? null, seenAt: String(Date.now()) },
      ...(!record.directory ? { directory: hello.home } : {}) });
  }
  private offline(id: string): string {
    const record = this.need(id);
    return this.links.online(id) ? `${record.name} is paused in the Jarvy client: its person stopped Bots working there for now` : `${record.name} is offline: the Jarvy client isn't running there or can't reach Jarvy`;
  }
  private home(record: EnvironmentRecord): string { return (record.spec.home ?? "").replaceAll("\\", "/") || (record.spec.platform === "win32" ? "C:/" : "/"); }
  private directory(record: EnvironmentRecord): string { return (record.directory || record.spec.home || "").replaceAll("\\", "/") || this.home(record); }
  /** Exact working directory for a terminal: never trims, so POSIX directories ending in spaces are preserved. */
  private terminalCwd(record: EnvironmentRecord, value: string): string {
    const home = this.home(record);
    if (value.length > 1000 || /[\x00-\x1f]/.test(value)) throw new ChatError(400, "directory must be an absolute path or start with ~/");
    if (record.spec.platform === "win32") {
      const raw = value.replaceAll("\\", "/");
      if (raw === "~") return home;
      if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
      if (/^[A-Za-z]:\//.test(raw)) return raw;
      if (/^\/[A-Za-z](\/|$)/.test(raw)) return toWindows(raw);
    } else {
      if (value === "~") return home;
      if (value.startsWith("~/")) return `${home}/${value.slice(2)}`;
      if (value.startsWith("/")) return value;
    }
    throw new ChatError(400, "directory must be an absolute path or start with ~/");
  }
  /** An absolute directory there: `~` and paths under it are its home; on Windows also `C:\…` or `/c/…`. */
  private directoryIn(record: EnvironmentRecord, value: unknown): string {
    const raw = text(value, 1000).replaceAll("\\", "/"), home = this.home(record);
    if (!raw || raw === "~") return home;
    if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
    if (/[\x00-\x1f]/.test(raw)) throw new ChatError(400, "directory must be an absolute path or start with ~/");
    if (record.spec.platform === "win32") {
      if (/^[A-Za-z]:\//.test(raw)) return raw;
      if (/^\/[A-Za-z](\/|$)/.test(raw)) return toWindows(raw);
    } else if (raw.startsWith("/")) return raw;
    throw new ChatError(400, "directory must be an absolute path or start with ~/");
  }
  private view(record: EnvironmentRecord): Device {
    const { spec } = record, sandbox = this.links.sandboxInfo(record.id);
    return { id: record.id, name: record.name, description: record.description, platform: spec.platform ?? "", arch: spec.arch ?? "",
      home: spec.home ?? "", directory: record.directory || spec.home || "", online: this.links.online(record.id), paused: this.links.paused(record.id),
      seenAt: this.links.online(record.id) ? Date.now() : spec.seenAt ? Number(spec.seenAt) : null,
      shells: { ...(spec.shellBash ? { bash: spec.shellBash } : {}), ...(spec.shellPowershell ? { powershell: spec.shellPowershell } : {}) },
      shell: (spec.shell as Device["shell"]) ?? "auto", activeShell: activeShell(record),
      capabilities: spec.capabilities ? spec.capabilities.split(",").filter(Boolean) : [], client: spec.client ?? "",
      ...(sandbox ? { sandbox } : {}), botIds: this.store.environments.grantees(record.id) };
  }
  private need(id: string): EnvironmentRecord {
    const record = this.store.environments.get(id);
    if (!record || record.kind !== "device") throw new ChatError(404, "No computer with this id", "device_missing");
    return record;
  }
  private freeName(name: string): string {
    const taken = new Set(this.store.environments.devices().map(record => record.name));
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
  }
}

/** The shell commands run in: the owner's choice when the computer has it; otherwise Git Bash (or bash), then
 * PowerShell. */
export function activeShell(record: EnvironmentRecord): DeviceShell | null {
  const has = { bash: !!record.spec.shellBash, powershell: !!record.spec.shellPowershell }, chosen = record.spec.shell;
  if ((chosen === "bash" || chosen === "powershell") && has[chosen]) return chosen;
  return has.bash ? "bash" : has.powershell ? "powershell" : null;
}

/** A command as a PowerShell script: output in UTF-8, secret variables (`${JARVY_SECRET_X}`, as the placeholders
 * become) read from the environment, and the last program's exit code as the script's. */
export function powershellScript(command: string, secrets: string[]): string {
  return ["$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8",
    ...secrets.map(name => `\${${name}} = $env:${name}`),
    // One pipeline into Out-Default, ended before `exit`: Windows PowerShell holds a table back while it sizes its
    // columns, and an `exit` with output still held drops it (and the strings queued behind it).
    `& {\n${command}\n} | Out-Default`,
    "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }", ""].join("\n");
}

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
