/** A port a Bot published from its sandbox (A74): Jarvy listens on `hostPort`, on the address it listens on, and
 * forwards there to `port` in the sandbox, for the owner's browser and this Jarvy's other Bots. The name and
 * description are the Bot's words, kept as written. */
export interface PublishedPort {
  botId: string;
  /** The port in the sandbox. */
  port: number;
  name: string;
  description: string;
  /** Jarvy's port for it, kept while it is published. */
  hostPort: number;
  /** How to open it from another device; empty when Jarvy listens on this machine only. */
  urls: string[];
  /** What a request finds there now (see PortState). */
  state: PortState;
  createdAt: number;
  updatedAt: number;
}
/** `live`: something listens there for the network. `local`: something listens, but only on the sandbox's loopback
 * (127.0.0.1 or ::1), which Jarvy can't reach. `idle`: nothing listens. `stopped`: the sandbox isn't running.
 * `unknown`: the check itself failed, such as without Docker. */
export type PortState = "live" | "local" | "idle" | "stopped" | "unknown";
/** The ports Jarvy takes for published ones, both ends included. */
export interface PortRange { from: number; to: number }
