import { randomUUID } from "node:crypto";
import xtermHeadless from "@xterm/headless";
import xtermSerialize from "@xterm/addon-serialize";
import type { WebSocket, RawData } from "ws";
import type { TerminalClientMessage, TerminalServerMessage, TerminalSession, TerminalState } from "../../contract/terminal.js";
import { ChatError } from "../shared/chat.js";
import type { PtyHandle, PtyOpenOptions } from "../shared/terminal.js";

const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

type HeadlessTerminal = InstanceType<typeof Terminal>;
type HeadlessSerialize = InstanceType<typeof SerializeAddon>;

const SCROLLBACK = 5000;
const MAX_PER_ENV = 16;
const MAX_TOTAL = 64;
const FOREGROUND_POLL_MS = 4000;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const SHELL_NAMES = new Set(["bash", "-bash", "sh", "-sh", "zsh", "-zsh", "fish", "dash", "ash", "pwsh", "powershell", "cmd"]);

export interface TerminalDependencies {
  openPty(environmentId: string, options: PtyOpenOptions): Promise<{ pty: PtyHandle; cwd: string }>;
  changed(): void;
}

const clampCols = (value: unknown) => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_COLS;
  return Math.max(20, Math.min(400, n));
};
const clampRows = (value: unknown) => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_ROWS;
  return Math.max(5, Math.min(160, n));
};
const cleanName = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 60) : "";

const DEFAULT_ENV: Record<string, string> = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
};

class ManagedTerminal {
  readonly id: string;
  readonly environmentId: string;
  name: string;
  state: TerminalState = "running";
  cols: number;
  rows: number;
  cwd = "";
  foreground: string | undefined;
  exitCode: number | null = null;
  exitReason: string | undefined;
  readonly createdAt = Date.now();
  private pty: PtyHandle | null = null;
  private headless: HeadlessTerminal;
  private serialize: HeadlessSerialize;
  private readonly clients = new Set<WebSocket>();
  private disposed = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(
    environmentId: string,
    name: string,
    cols: number,
    rows: number,
    private readonly onChanged: () => void,
  ) {
    this.id = randomUUID();
    this.environmentId = environmentId;
    this.name = name;
    this.cols = cols;
    this.rows = rows;
    const { headless, serialize } = this.makeHeadless(cols, rows);
    this.headless = headless;
    this.serialize = serialize;
  }

  private makeHeadless(cols: number, rows: number): { headless: HeadlessTerminal; serialize: HeadlessSerialize } {
    const headless = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serialize = new SerializeAddon();
    headless.loadAddon(serialize);
    return { headless, serialize };
  }

  view(): TerminalSession {
    return {
      id: this.id,
      environmentId: this.environmentId,
      name: this.name,
      state: this.state,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      ...(this.foreground ? { foreground: this.foreground } : {}),
      exitCode: this.exitCode,
      ...(this.exitReason ? { exitReason: this.exitReason } : {}),
      createdAt: this.createdAt,
      attachedCount: this.clients.size,
    };
  }

  async start(openPty: TerminalDependencies["openPty"], resetBuffer = false): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.generation;
    if (resetBuffer) {
      this.headless.dispose();
      const next = this.makeHeadless(this.cols, this.rows);
      this.headless = next.headless;
      this.serialize = next.serialize;
      this.state = "running";
      this.exitCode = null;
      this.exitReason = undefined;
      this.foreground = undefined;
    }
    const { pty, cwd } = await openPty(this.environmentId, {
      cwd: "",
      cols: this.cols,
      rows: this.rows,
      env: DEFAULT_ENV,
      onData: chunk => {
        if (this.disposed || this.generation !== gen) return;
        this.headless.write(chunk);
        for (const ws of this.clients) {
          if (ws.readyState === ws.OPEN) ws.send(chunk);
        }
      },
    });
    if (this.disposed || this.generation !== gen) {
      pty.close();
      return;
    }
    this.pty = pty;
    this.cwd = cwd;
    this.state = "running";
    this.startPolling(gen);
    if (resetBuffer) {
      // Re-sync any already-attached browser clients onto the fresh session.
      for (const ws of this.clients) this.sendSnapshot(ws);
    }
    void pty.exited.then(exit => {
      if (this.disposed || this.generation !== gen) return;
      this.stopPolling();
      this.pty = null;
      this.state = "exited";
      this.exitCode = exit.exitCode;
      this.exitReason = exit.reason;
      this.foreground = undefined;
      this.broadcast({ t: "exit", exitCode: exit.exitCode, ...(exit.reason ? { reason: exit.reason } : {}) });
      this.onChanged();
    });
  }

  attach(ws: WebSocket): void {
    if (this.disposed) { ws.close(1001, "Terminal closed"); return; }
    this.clients.add(ws);
    this.sendSnapshot(ws);
    this.onChanged();

    ws.on("message", (raw: RawData, binary: boolean) => {
      if (this.disposed) return;
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
      if (binary) {
        if (this.state === "running") this.pty?.write(bytes);
        return;
      }
      let message: TerminalClientMessage;
      try { message = JSON.parse(bytes.toString("utf8")) as TerminalClientMessage; } catch { return; }
      if (message.t === "resize") {
        this.resize(clampCols(message.cols), clampRows(message.rows));
      }
    });

    const detach = () => {
      if (!this.clients.delete(ws)) return;
      this.onChanged();
    };
    ws.on("close", detach);
    ws.on("error", () => { detach(); ws.terminate(); });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols;
    this.rows = rows;
    this.headless.resize(cols, rows);
    if (this.state === "running") this.pty?.resize(cols, rows);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    const pty = this.pty;
    this.pty = null;
    pty?.close();
    for (const ws of this.clients) {
      try { ws.close(1000, "Terminal closed"); } catch {}
    }
    this.clients.clear();
    this.headless.dispose();
  }

  private sendSnapshot(ws: WebSocket): void {
    // Wait until queued writes flush into the headless buffer so the snapshot matches live output seamlessly.
    this.headless.write("", () => {
      if (this.disposed || ws.readyState !== ws.OPEN) return;
      const data = this.serialize.serialize({ scrollback: SCROLLBACK });
      const msg: TerminalServerMessage = {
        t: "snapshot",
        cols: this.cols,
        rows: this.rows,
        data,
        state: this.state,
        exitCode: this.exitCode,
        ...(this.exitReason ? { exitReason: this.exitReason } : {}),
        ...(this.foreground ? { foreground: this.foreground } : {}),
      };
      ws.send(JSON.stringify(msg));
    });
  }

  private broadcast(message: TerminalServerMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  private startPolling(gen: number): void {
    this.stopPolling();
    if (!this.pty?.foreground) return;
    this.pollTimer = setInterval(() => {
      if (this.disposed || this.generation !== gen || !this.pty?.foreground) return;
      void this.pty.foreground().then(name => {
        if (this.disposed || this.generation !== gen) return;
        const normalized = name && !SHELL_NAMES.has(name.toLowerCase()) ? name.slice(0, 40) : undefined;
        if (normalized !== this.foreground) {
          this.foreground = normalized;
          this.broadcast({ t: "title", ...(normalized ? { foreground: normalized } : {}) });
          this.onChanged();
        }
      }).catch(() => {});
    }, FOREGROUND_POLL_MS);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}

/** Manages persistent interactive terminals across all work environments (A103).
 * Sessions live in memory on the Jarvy server with a headless virtual terminal (`@xterm/headless`) so network drops,
 * page switches and tab closes leave running shells and TUI tools intact. */
export class TerminalService {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly deps: TerminalDependencies) {}

  list(environmentId?: string): TerminalSession[] {
    const all = [...this.sessions.values()];
    const filtered = environmentId ? all.filter(item => item.environmentId === environmentId) : all;
    return filtered.sort((a, b) => a.createdAt - b.createdAt).map(item => item.view());
  }

  get(id: string): TerminalSession {
    return this.need(id).view();
  }

  async create(environmentId: string, options: { name?: unknown; cols?: unknown; rows?: unknown } = {}): Promise<TerminalSession> {
    if (!environmentId || typeof environmentId !== "string") throw new ChatError(400, "environmentId is required");
    if (this.sessions.size >= MAX_TOTAL) throw new ChatError(409, `At most ${MAX_TOTAL} terminals may be open at once`, "terminal_limit");
    const envCount = [...this.sessions.values()].filter(item => item.environmentId === environmentId).length;
    if (envCount >= MAX_PER_ENV) throw new ChatError(409, `At most ${MAX_PER_ENV} terminals may be open per environment`, "terminal_limit");
    const next = (this.counters.get(environmentId) ?? 0) + 1;
    const name = cleanName(options.name) || `Terminal ${next}`;
    const cols = clampCols(options.cols), rows = clampRows(options.rows);
    const session = new ManagedTerminal(environmentId, name, cols, rows, () => this.deps.changed());
    try {
      await session.start(this.deps.openPty);
    } catch (error) {
      session.dispose();
      throw error;
    }
    this.counters.set(environmentId, next);
    this.sessions.set(session.id, session);
    this.deps.changed();
    return session.view();
  }

  rename(id: string, name: unknown): TerminalSession {
    const session = this.need(id);
    const cleaned = cleanName(name);
    if (!cleaned) throw new ChatError(400, "A terminal name is required");
    session.name = cleaned;
    this.deps.changed();
    return session.view();
  }

  async restart(id: string, options: { cols?: unknown; rows?: unknown } = {}): Promise<TerminalSession> {
    const session = this.need(id);
    if (options.cols !== undefined || options.rows !== undefined) {
      session.resize(clampCols(options.cols ?? session.cols), clampRows(options.rows ?? session.rows));
    }
    await session.start(this.deps.openPty, true);
    this.deps.changed();
    return session.view();
  }

  close(id: string): void {
    const session = this.need(id);
    this.sessions.delete(id);
    session.dispose();
    this.deps.changed();
  }

  /** Closes every terminal belonging to an environment that was stopped, reset, switched or deleted. */
  closeForEnvironment(environmentId: string): void {
    let removed = false;
    for (const [id, session] of [...this.sessions.entries()]) {
      if (session.environmentId !== environmentId) continue;
      this.sessions.delete(id);
      session.dispose();
      removed = true;
    }
    if (removed) this.deps.changed();
  }

  has(id: string): boolean { return this.sessions.has(id); }

  attach(id: string, ws: WebSocket): void {
    const session = this.sessions.get(id);
    if (!session) { ws.close(4404, "Terminal not found"); return; }
    session.attach(ws);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private need(id: string): ManagedTerminal {
    const session = this.sessions.get(id);
    if (!session) throw new ChatError(404, "Terminal not found", "terminal_missing");
    return session;
  }
}
