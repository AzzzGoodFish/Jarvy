/** Work environments as the interface sees them (A50, A57). */
/** `host` is the owner's computer, the machine running Jarvy; `computer` a Bot's sandbox, a Docker container
 * only it uses; `ssh` a machine the owner added, reached over SSH (A57). */
export type EnvironmentKind = "host" | "computer" | "ssh";
/** What can be a Bot's default: never an SSH machine, which is a place a Bot is granted and switches to. */
export type HomeKind = "host" | "computer";
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
/** Where a Bot works, for the interface: its default and current environment (and the SSH machine's name when it is
 * on one), its computer when it has one, whether the owner lets it use their computer, and each SSH machine with
 * whether the Bot may use it. */
export interface BotPlacement { home: HomeKind; current: EnvironmentKind; currentName?: string; computer: ComputerStatus | null; docker: boolean;
  hostGranted: boolean; machines: { id: string; name: string; granted: boolean }[] }
