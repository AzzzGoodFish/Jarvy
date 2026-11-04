/** Work environments as the interface sees them (A50, A57, A68). `computer` is a Bot's sandbox, a Docker container
 * only it uses and its only default; `ssh` a machine the owner added, reached over SSH (A57), granted to a Bot and
 * switched to. The owner's computer is one of those when the owner adds it. */
export type EnvironmentKind = "computer" | "ssh";
/** An SSH machine (A57) as Settings shows it: never its key. */
export interface SshMachine {
  id: string; name: string; host: string; port: number; user: string;
  /** Where tools start there; its home unless the owner chose another. */
  directory: string; home: string; platform: string;
  /** The owner's notes on it, several lines at most 2000 characters; empty when none. */
  description: string;
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
/** A Bot's sandbox in Bot info: its state, and what it is: the container's name, the image it is made from, and the
 * folder on this machine mounted as its workspace. */
export interface ComputerInfo extends ComputerStatus { container: string; image: string; workspace: string; mount: string; limits: ComputerLimits }
/** What a sandbox may use at most (A75): memory in bytes, CPUs in cores; null is no limit. A limit caps and reserves
 * nothing, so a sandbox under it takes only what it uses. */
export interface ComputerLimits { memory: number | null; cpus: number | null }
/** What a running sandbox uses now: memory in bytes, and CPU in percent of one core, so over 100 with several. */
export interface ComputerUsage { memory: number; cpu: number }
/** This machine's CPUs and memory in bytes, as Docker sees them: what limits may go up to. */
export interface ComputerCapacity { cpus: number; memory: number }
/** Bot info's view of a sandbox's resources: its usage when it runs, and this machine's capacity when Docker answers. */
export interface ComputerResources { usage: ComputerUsage | null; capacity: ComputerCapacity | null }
/** Where a Bot works, for the interface: whether it is in its own sandbox or on an SSH machine (and that machine's
 * name), its sandbox, and the machines its owner lets it use. */
export interface BotPlacement { current: EnvironmentKind; currentName?: string; computer: ComputerInfo | null; docker: boolean;
  machines: { id: string; name: string; granted: boolean }[] }
