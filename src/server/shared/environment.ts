/** Where a Bot's file and command tools run (A50): Jarvy's own interface between Pi's tools and the code that reaches
 * an environment, so neither Pi nor the execution transport leaks past its adapter. Paths are absolute inside the
 * environment. */
export interface WorkEnvironment {
  /** Stable name, such as `host`. */
  readonly id: string;
  readonly kind: EnvironmentKind;
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
  /** The size of the regular file at the path, following links; null when there is none. */
  fileSize(path: string): Promise<number | null>;
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

/** `host` is the owner's computer, the machine running Jarvy; `computer` a Bot's sandbox, a Docker container
 * only it uses. */
export type EnvironmentKind = "host" | "computer";
export interface EnvironmentRecord {
  id: string; ownerId: string; kind: EnvironmentKind;
  /** The Bot a computer belongs to. */
  botId: string | null;
  /** How to reach it, such as the container's name. */
  spec: Record<string, string>;
}
/** A Bot's sandbox as people see it. `preparing` covers building the image and creating or starting the
 * container; `unavailable` means this machine has no usable Docker. */
export type ComputerState = "preparing" | "running" | "stopped" | "failed" | "unavailable";
export interface ComputerStatus { state: ComputerState; error?: string }
/** Where a Bot works, for the interface: its default and current environment, its computer when it has one, and
 * whether the owner lets it use their computer (the one environment granted so far). */
export interface BotPlacement { home: EnvironmentKind; current: EnvironmentKind; computer: ComputerStatus | null; docker: boolean; hostGranted: boolean }
