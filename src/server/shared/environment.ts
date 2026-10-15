/** Where a Bot's file and command tools run (A50): Jarvy's own interface between Pi's tools and the code that reaches
 * an environment, so neither Pi nor the execution transport leaks past its adapter. Paths are absolute inside the
 * environment. */
export interface WorkEnvironment {
  /** Stable name, such as `host`. */
  readonly id: string;
  /** The directory the tools start in. */
  readonly cwd: string;
  /** Runs a shell command, streaming its output. A non-zero exit is a result, not an error; a timeout throws
   * `timeout:<seconds>` and an abort throws `aborted`, as Pi's bash tool expects. */
  exec(command: string, options: ExecOptions): Promise<{ exitCode: number | null }>;
  readFile(path: string): Promise<Buffer>;
  /** The first bytes of a file (fewer when it is shorter), to tell what kind of file it is. */
  head(path: string, bytes: number): Promise<Buffer>;
  /** Writes the file, creating missing parent directories. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Creates the directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Releases what the environment holds open (connections, processes); idempotent. */
  close(): Promise<void>;
}

export interface ExecOptions {
  cwd: string;
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  /** Seconds. */
  timeout?: number;
  /** The environment Pi built for the command. Only an environment on this machine passes it on; others keep their own. */
  env?: Record<string, string>;
}
