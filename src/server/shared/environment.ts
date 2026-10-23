/** Where a Bot's file and command tools run (A50): Jarvy's own interface between Pi's tools and the code that reaches
 * an environment, so neither Pi nor the execution transport leaks past its adapter. Paths are absolute inside the
 * environment. */
export interface WorkEnvironment {
  /** Stable name, such as `host`. */
  readonly id: string;
  readonly kind: EnvironmentKind;
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

/** `host` is the owner's computer, the machine running Jarvy; `computer` a Bot's sandbox, a Docker container
 * only it uses; `ssh` a machine the owner added, reached over SSH (A57). */
export type EnvironmentKind = "host" | "computer" | "ssh";
/** What can be a Bot's default: never an SSH machine, which is a place a Bot is granted and switches to. */
export type HomeKind = "host" | "computer";
export interface EnvironmentRecord {
  id: string; ownerId: string; kind: EnvironmentKind;
  /** The Bot a computer belongs to. */
  botId: string | null;
  /** What the owner calls it (SSH machines). */
  name: string;
  /** Where the tools start, when it isn't fixed by the kind (SSH machines). */
  directory: string | null;
  /** How to reach it: a container's name; an SSH machine's host, port, user, home and system. */
  spec: Record<string, string>;
}
/** An SSH machine (A57) as Settings shows it: never its key. */
export interface SshMachine {
  id: string; name: string; host: string; port: number; user: string;
  /** Where tools start there; its home unless the owner chose another. */
  directory: string; home: string; platform: string;
  /** The host keys the owner accepted, as `ssh-keygen -l` words them. */
  fingerprints: string[];
  /** How Jarvy logs in (A59): with its key, or with the password when the machine refuses keys. */
  login: "key" | "password";
  /** Jarvy's key for this machine, the line it adds to authorized_keys; null when it can't be read. */
  publicKey: string | null;
  /** The Bots that may switch to it. */
  botIds: string[];
}
/** A host's keys as a scan found them: `type base64` lines, and their fingerprints to show the owner. */
export interface HostKeys { keys: string[]; fingerprints: string[] }
/** A Bot's sandbox as people see it. `preparing` covers building the image and creating or starting the
 * container; `unavailable` means this machine has no usable Docker. */
export type ComputerState = "preparing" | "running" | "stopped" | "failed" | "unavailable";
export interface ComputerStatus { state: ComputerState; error?: string }
/** Where a Bot works, for the interface: its default and current environment (and the SSH machine's name when it is
 * on one), its computer when it has one, whether the owner lets it use their computer, and each SSH machine with
 * whether the Bot may use it. */
export interface BotPlacement { home: HomeKind; current: EnvironmentKind; currentName?: string; computer: ComputerStatus | null; docker: boolean;
  hostGranted: boolean; machines: { id: string; name: string; granted: boolean }[] }
