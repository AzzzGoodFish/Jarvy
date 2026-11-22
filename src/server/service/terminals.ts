import { randomUUID } from "node:crypto";
import xtermHeadless from "@xterm/headless";
import xtermSerialize from "@xterm/addon-serialize";
import type { WebSocket, RawData } from "ws";
import type { TerminalClientMessage, TerminalServerMessage, TerminalSession, TerminalShell, TerminalState } from "../../contract/terminal.js";
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
  openPty(environmentId: string, options: PtyOpenOptions): Promise<{ pty: PtyHandle; cwd: string; shell?: TerminalShell }>;
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
const cleanShell = (value: unknown): TerminalShell | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "bash" || value === "powershell" || value === "cmd") return value;
  throw new ChatError(400, "shell must be bash, powershell or cmd");
};
const cleanCwd = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ChatError(400, "cwd must be a string");
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 1000 || /[\x00-\x1f]/.test(trimmed)) throw new ChatError(400, "Invalid cwd");
  return trimmed;
};

const DEFAULT_ENV: Record<string, string> = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
};

/** Per-viewer snapshot/live ordering state: buffers post-barrier live chunks until the snapshot frame is sent. */
interface ClientState {
  ready: boolean;
  pending: Buffer[];
  barrier: number;
}

class ManagedTerminal {
  readonly id: string;
  readonly environmentId: string;
  name: string;
  state: TerminalState = "running";
  cols: number;
  rows: number;
  cwd = "";
  shell: TerminalShell | undefined;
  foreground: string | undefined;
  exitCode: number | null = null;
  exitReason: string | undefined;
  readonly createdAt = Date.now();
  private readonly requestedShell: TerminalShell | undefined;
  private readonly requestedCwd: string | undefined;
  private pty: PtyHandle | null = null;
  private headless: HeadlessTerminal;
  private serialize: HeadlessSerialize;
  private readonly clients = new Map<WebSocket, ClientState>();
  private disposed = false;
  private restarting = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private nextGen = 0;

  constructor(
    environmentId: string,
    name: string,
    cols: number,
    rows: number,
    private readonly onChanged: () => void,
    requestedShell?: TerminalShell,
    requestedCwd?: string,
  ) {
    this.id = randomUUID();
    this.environmentId = environmentId;
    this.name = name;
    this.cols = cols;
    this.rows = rows;
    this.requestedShell = requestedShell;
    this.requestedCwd = requestedCwd;
    const { headless, serialize } = this.makeHeadless(cols, rows);
    this.headless = headless;
    this.serialize = serialize;
  }

  get isDisposed(): boolean { return this.disposed; }

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
      ...(this.shell ? { shell: this.shell } : {}),
      ...(this.foreground ? { foreground: this.foreground } : {}),
      exitCode: this.exitCode,
      ...(this.exitReason ? { exitReason: this.exitReason } : {}),
      createdAt: this.createdAt,
      attachedCount: this.clients.size,
    };
  }

  /** Initial PTY open for a newly created terminal. */
  async start(openPty: TerminalDependencies["openPty"]): Promise<void> {
    await this.openStaged(openPty, this.cols, this.rows, false);
  }

  /** Restarts an exited terminal in place: stages the replacement PTY before committing so failures keep the old
   * scrollback and exited state intact. Rejects if still running or another restart is already in progress. */
  async restart(openPty: TerminalDependencies["openPty"], nextCols: number, nextRows: number): Promise<void> {
    if (this.disposed) throw new ChatError(404, "Terminal not found", "terminal_missing");
    if (this.restarting) throw new ChatError(409, "Terminal is already restarting");
    if (this.state !== "exited") throw new ChatError(409, "Terminal is still running");
    this.restarting = true;
    try {
      await this.openStaged(openPty, nextCols, nextRows, true);
    } finally {
      this.restarting = false;
    }
  }

  private async openStaged(openPty: TerminalDependencies["openPty"], cols: number, rows: number, replace: boolean): Promise<void> {
    if (this.disposed) throw new ChatError(404, "Terminal not found", "terminal_missing");
    const gen = ++this.nextGen;
    const staged: Buffer[] = [];
    let committed = false;

    const { pty, cwd, shell } = await openPty(this.environmentId, {
      cwd: this.requestedCwd ?? "",
      ...(this.requestedShell ? { shell: this.requestedShell } : {}),
      cols,
      rows,
      env: DEFAULT_ENV,
      onData: chunk => {
        if (this.disposed) return;
        if (!committed) {
          staged.push(chunk);
          return;
        }
        if (this.generation !== gen) return;
        this.handleLiveData(chunk);
      },
    });

    if (this.disposed) {
      pty.close();
      throw new ChatError(404, "Terminal not found", "terminal_missing");
    }

    // Commit synchronously once the replacement PTY is open so failed opens never corrupt state or scrollback.
    if (replace) {
      const next = this.makeHeadless(cols, rows);
      for (const chunk of staged) next.headless.write(chunk);
      this.headless.dispose();
      this.headless = next.headless;
      this.serialize = next.serialize;
      this.cols = cols;
      this.rows = rows;
    } else {
      for (const chunk of staged) this.headless.write(chunk);
    }

    this.generation = gen;
    this.pty = pty;
    this.cwd = cwd;
    this.shell = shell;
    this.state = "running";
    this.exitCode = null;
    this.exitReason = undefined;
    this.foreground = undefined;
    committed = true;
    this.startPolling(gen);

    if (replace) {
      // Establish a fresh snapshot/live boundary for every currently attached viewer.
      for (const [ws, client] of this.clients) this.queueSnapshot(ws, client);
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
    const client: ClientState = { ready: false, pending: [], barrier: 0 };
    this.clients.set(ws, client);
    this.queueSnapshot(ws, client);
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
    for (const ws of this.clients.keys()) {
      try { ws.close(1000, "Terminal closed"); } catch {}
    }
    this.clients.clear();
    this.headless.dispose();
  }

  private handleLiveData(chunk: Buffer): void {
    this.headless.write(chunk);
    for (const [ws, client] of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (client.ready) ws.send(chunk);
      else client.pending.push(chunk);
    }
  }

  /** Establishes a single ordered snapshot/live boundary per viewer: any chunk queued into `headless` after this
   * barrier is buffered in `client.pending` and flushed immediately after the `snapshot` frame, delivering every
   * subsequent chunk exactly once and never before the snapshot. */
  private queueSnapshot(ws: WebSocket, client: ClientState): void {
    client.ready = false;
    client.pending = [];
    const barrier = ++client.barrier;
    const targetHeadless = this.headless;
    const targetSerialize = this.serialize;
    targetHeadless.write("", () => {
      if (this.disposed || this.headless !== targetHeadless || this.clients.get(ws) !== client || client.barrier !== barrier || ws.readyState !== ws.OPEN) return;
      const data = targetSerialize.serialize({ scrollback: SCROLLBACK });
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
      for (const chunk of client.pending) {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      }
      client.pending = [];
      client.ready = true;
    });
  }

  private broadcast(message: TerminalServerMessage): void {
    const text = JSON.stringify(message);
    for (const [ws, client] of this.clients) {
      // Non-ready clients will observe the latest state/foreground inside their snapshot frame.
      if (client.ready && ws.readyState === ws.OPEN) ws.send(text);
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
  /** Reservations for terminals currently awaiting `openPty`, counted against limits and cancelled on teardown. */
  private readonly pending = new Map<string, ManagedTerminal>();
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

  async create(environmentId: string, options: { name?: unknown; cols?: unknown; rows?: unknown; shell?: unknown; cwd?: unknown } = {}): Promise<TerminalSession> {
    if (!environmentId || typeof environmentId !== "string") throw new ChatError(400, "environmentId is required");
    const requestedShell = cleanShell(options.shell);
    const requestedCwd = cleanCwd(options.cwd);
    if (this.sessions.size + this.pending.size >= MAX_TOTAL) {
      throw new ChatError(409, `At most ${MAX_TOTAL} terminals may be open at once`, "terminal_limit");
    }
    const envCount = this.countForEnvironment(environmentId);
    if (envCount >= MAX_PER_ENV) {
      throw new ChatError(409, `At most ${MAX_PER_ENV} terminals may be open per environment`, "terminal_limit");
    }
    const next = (this.counters.get(environmentId) ?? 0) + 1;
    this.counters.set(environmentId, next);
    const name = cleanName(options.name) || `Terminal ${next}`;
    const cols = clampCols(options.cols), rows = clampRows(options.rows);
    const session = new ManagedTerminal(environmentId, name, cols, rows, () => this.deps.changed(), requestedShell, requestedCwd);
    this.pending.set(session.id, session);
    try {
      await session.start(this.deps.openPty);
    } catch (error) {
      this.pending.delete(session.id);
      session.dispose();
      throw error;
    }
    if (!this.pending.delete(session.id) || session.isDisposed) {
      session.dispose();
      throw new ChatError(409, "Environment was closed while starting terminal");
    }
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
    const cols = options.cols !== undefined ? clampCols(options.cols) : session.cols;
    const rows = options.rows !== undefined ? clampRows(options.rows) : session.rows;
    await session.restart(this.deps.openPty, cols, rows);
    this.deps.changed();
    return session.view();
  }

  close(id: string): void {
    const session = this.need(id);
    this.sessions.delete(id);
    session.dispose();
    this.deps.changed();
  }

  /** Closes every open or pending terminal belonging to an environment that was stopped, reset, switched or deleted. */
  closeForEnvironment(environmentId: string): void {
    let removed = false;
    for (const [id, session] of [...this.pending.entries()]) {
      if (session.environmentId !== environmentId) continue;
      this.pending.delete(id);
      session.dispose();
    }
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
    for (const session of this.pending.values()) session.dispose();
    this.pending.clear();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  private countForEnvironment(environmentId: string): number {
    let count = 0;
    for (const item of this.sessions.values()) if (item.environmentId === environmentId) count++;
    for (const item of this.pending.values()) if (item.environmentId === environmentId) count++;
    return count;
  }

  private need(id: string): ManagedTerminal {
    const session = this.sessions.get(id);
    if (!session) throw new ChatError(404, "Terminal not found", "terminal_missing");
    return session;
  }
}
