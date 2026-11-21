/** How a computer's client talks to Jarvy (A96), shared by the server and the client. The client opens one WebSocket
 * at `DEVICE_PATH` with `Authorization: Device <token>`. Text frames are JSON control messages; binary frames carry a
 * pi-env daemon's bytes: a 4-byte channel number (big-endian), then the bytes. */
export const DEVICE_PROTOCOL = 1;
export const DEVICE_PATH = "/api/devices/connect";
/** Where the client gets the pi-env daemon for its system, with the same token. */
export const DEVICE_DAEMON_PATH = "/api/devices/daemon";
/** Where the command-line client is served, one file, for Node 22 or later. */
export const DEVICE_CONNECTOR_PATH = "/api/devices/connector.mjs";

/** Client → Jarvy. `hello` first, saying what the computer is; `state` when its person pauses or resumes it; `exit`
 * when a daemon it ran ended. */
export type DeviceToJarvy =
  | { t: "hello"; protocol: number; platform: string; arch: string; home: string; hostname: string;
      shells: { bash?: string; powershell?: string }; client: string; capabilities: string[]; paused: boolean }
  | { t: "state"; paused: boolean }
  | { t: "exit"; ch: number; code: number | null; error?: string };
/** Jarvy → client. `open` asks it to run the daemon with these arguments on a new channel, for the Bot named; `pty_open`
 * asks it to open an interactive pseudo-terminal (e.g. Windows ConPTY, A103) on a new channel; `pty_resize` updates its
 * dimensions; `close` stops any channel. Close codes: 4000 replaced by a newer connection, 4001 protocol mismatch,
 * 4002 no hello, 4003 unpaired. */
export type JarvyToDevice =
  | { t: "welcome"; id: string; name: string; protocol: number }
  | { t: "error"; code: "protocol"; protocol: number }
  | { t: "open"; ch: number; args: string[]; bot?: string }
  | { t: "pty_open"; ch: number; cols: number; rows: number; cwd: string; argv?: string[]; env?: Record<string, string> }
  | { t: "pty_resize"; ch: number; cols: number; rows: number }
  | { t: "close"; ch: number };
