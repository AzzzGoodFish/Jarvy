/** Interactive persistent terminals in work environments (A103).
 *
 * A terminal session lives on the Jarvy server (backed by a headless virtual terminal and a remote PTY),
 * so closing a tab, switching pages or losing network never kills the running shell or TUI tool.
 *
 * WebSocket wire protocol at `/api/terminals/:id/ws`:
 * - Text frames carry JSON control messages (`TerminalClientMessage` / `TerminalServerMessage`).
 * - Binary frames carry raw UTF-8 terminal bytes (browser → server: stdin; server → browser: live stdout).
 */
export const TERMINAL_WS_PREFIX = "/api/terminals/";
export const TERMINAL_WS_SUFFIX = "/ws";

export type TerminalState = "running" | "exited";
export type TerminalShell = "bash" | "powershell" | "cmd";

export interface TerminalSession {
  id: string;
  environmentId: string;
  name: string;
  state: TerminalState;
  cols: number;
  rows: number;
  cwd: string;
  /** Shell used to launch this terminal, when known. */
  shell?: TerminalShell;
  /** Foreground program name when different from the login shell, if known. */
  foreground?: string;
  exitCode: number | null;
  exitReason?: string;
  createdAt: number;
  /** Number of browser views currently attached to this terminal. */
  attachedCount: number;
}

/** Browser → Server JSON control messages. */
export type TerminalClientMessage =
  | { t: "resize"; cols: number; rows: number };

/** Server → Browser JSON control messages. */
export type TerminalServerMessage =
  | {
      t: "snapshot";
      cols: number;
      rows: number;
      /** Serialized VT100/ANSI screen and scrollback state from the server's headless terminal. */
      data: string;
      state: TerminalState;
      exitCode: number | null;
      exitReason?: string;
      foreground?: string;
    }
  | { t: "exit"; exitCode: number | null; reason?: string }
  | { t: "title"; foreground?: string }
  | { t: "error"; message: string };
