export type PtyShell = "bash" | "powershell" | "cmd";

/** Server-side PTY abstraction (A103): keeps `@earendil-works/pi-env` and transport details inside `infra/env/`. */
export interface PtyOpenOptions {
  cwd: string;
  shell?: PtyShell;
  argv?: readonly string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  onData: (chunk: Buffer) => void;
}

export interface PtyExit {
  exitCode: number | null;
  reason?: string;
}

export interface PtyHandle {
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  foreground?(): Promise<string | undefined>;
  close(): void;
  readonly exited: Promise<PtyExit>;
}
