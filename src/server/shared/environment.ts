import type { EnvironmentKind } from "../../contract/environment.js";
/** Where a Bot's file and command tools run (A50): Jarvy's own interface between Pi's tools and the code that reaches
 * an environment, so neither Pi nor the execution transport leaks past its adapter. Paths are absolute inside the
 * environment. */
export interface WorkEnvironment {
  /** Stable name, such as `host`. */
  readonly id: string;
  readonly kind: EnvironmentKind;
  /** Runs on the machine Jarvy itself runs on (A65): Pi's own file paths are the tools' paths there, so long outputs
   * need no moving and the workspace is a local folder. */
  readonly local: boolean;
  /** The directory the tools start in. */
  readonly cwd: string;
  /** Where Jarvy puts files for the Bot there (long outputs, files from the chat); `cwd`/temp when unset. */
  readonly temp?: string;
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
  /** Secret values the command's placeholders need (A52): added to its environment wherever it runs, never to its text. */
  secrets?: Record<string, string>;
}

export interface EnvironmentRecord {
  id: string; ownerId: string; kind: EnvironmentKind;
  /** The Bot a computer belongs to. */
  botId: string | null;
  /** What the owner calls it (SSH machines). */
  name: string;
  /** Where the tools start, when it isn't fixed by the kind (SSH machines). */
  directory: string | null;
  /** What the owner wrote about it (SSH machines; empty otherwise): what it is for, what to watch out for. */
  description: string;
  /** How to reach it: a container's name; an SSH machine's host, port, user, home and system. */
  spec: Record<string, string>;
}
