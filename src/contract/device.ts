/** How a computer's client talks to Jarvy (A96, A108), shared by the server and the client. The client opens one WebSocket
 * at `DEVICE_PATH` with `Authorization: Device <token>`. Text frames are JSON control messages; binary frames carry a
 * pi-env daemon's, PTY's, or TCP tunnel's bytes: a 4-byte channel number (big-endian), then the bytes. */
export const DEVICE_PROTOCOL = 1;
export const DEVICE_PATH = "/api/devices/connect";
/** Where the client gets the pi-env daemon for its system, with the same token. */
export const DEVICE_DAEMON_PATH = "/api/devices/daemon";
/** Where the command-line client is served, one file, for Node 22 or later. */
export const DEVICE_CONNECTOR_PATH = "/api/devices/connector.mjs";

/** Sandbox compute capacity advertised by a `jarvy client --sandbox` compute node (A108). */
export interface SandboxNodeInfo {
  docker: boolean;
  cpus: number;
  memory: number;
  image: string;
  activeContainers: number;
  maxContainers: number;
}

/** Client → Jarvy. */
export type DeviceToJarvy =
  | {
    t: "hello"; protocol: number; platform: string; arch: string; home: string; hostname: string;
    shells: { bash?: string; powershell?: string }; client: string; capabilities: string[]; paused: boolean;
    sandbox?: SandboxNodeInfo;
  }
  | { t: "state"; paused: boolean; sandbox?: SandboxNodeInfo }
  | { t: "exit"; ch: number; code: number | null; error?: string }
  | { t: "rpc_result"; id: string; ok: boolean; result?: unknown; error?: string }
  | { t: "tcp_ready"; ch: number };

/** Jarvy → client.
 * - `open`: runs `pi-env` on a new channel (on the host, or inside `container` via `docker exec` for remote sandboxes).
 * - `pty_open` / `pty_resize`: native PTY channel (e.g. Windows ConPTY, A103).
 * - `rpc`: request/response compute control (`sandbox_ensure`, `sandbox_stop`, `sandbox_remove`, `sandbox_stats`, `workspace_pull`, `workspace_push_*`).
 * - `tcp_open`: opens a raw TCP tunnel from the client to `host:port` (for remote `ports.publish` forwarding).
 * - `close`: closes any channel.
 * Close codes: 4000 replaced by a newer connection, 4001 protocol mismatch, 4002 no hello, 4003 unpaired. */
export type JarvyToDevice =
  | { t: "welcome"; id: string; name: string; protocol: number }
  | { t: "error"; code: "protocol"; protocol: number }
  | { t: "open"; ch: number; args: string[]; bot?: string; container?: string }
  | { t: "pty_open"; ch: number; cols: number; rows: number; cwd: string; argv?: string[]; env?: Record<string, string> }
  | { t: "pty_resize"; ch: number; cols: number; rows: number }
  | { t: "rpc"; id: string; op: string; params?: Record<string, unknown> }
  | { t: "tcp_open"; ch: number; host: string; port: number }
  | { t: "close"; ch: number };
