import { Connection, openTerminal, type RemoteTerminal } from "@earendil-works/pi-env";
import type { PtyExit, PtyHandle, PtyOpenOptions } from "../../shared/terminal.js";
import type { DeviceLinks } from "./device-link.js";

const DAEMON_DIR = "/opt/jarvy";

/** Adapts a pi-env `RemoteTerminal` and its dedicated `Connection` into a `PtyHandle` (A103). */
export function wrapRemoteTerminal(connection: Connection, term: RemoteTerminal, onCleanup?: () => void): PtyHandle {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { connection.close(); } catch {}
    onCleanup?.();
  };
  const exited: Promise<PtyExit> = term.exited.then(
    exitCode => { cleanup(); return { exitCode }; },
    (error: unknown) => {
      cleanup();
      const code = (error as { code?: string })?.code;
      const reason = code === "aborted" ? "closed" : error instanceof Error ? error.message : String(error);
      return { exitCode: null, reason };
    },
  );
  return {
    write: data => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    foreground: async () => (await term.foreground().catch(() => undefined))?.name,
    close: () => { term.close(); cleanup(); },
    exited,
  };
}

/** Opens an interactive PTY inside a running Docker container sandbox via its dedicated pi-env connection (A103). */
export async function openContainerPty(container: string, options: PtyOpenOptions, onLog?: (text: string) => void): Promise<PtyHandle> {
  const connection = new Connection({
    command: ["docker", "exec", "-i", container, `${DAEMON_DIR}/pi-env`],
    ...(onLog ? { onLog: text => onLog(text.trim()) } : {}),
  });
  try {
    const term = await openTerminal(connection, {
      cwd: options.cwd,
      argv: options.argv ?? ["/bin/bash", "-l"],
      env: options.env,
      inheritEnv: true,
      cols: options.cols,
      rows: options.rows,
      onData: bytes => options.onData(Buffer.from(bytes)),
    });
    return wrapRemoteTerminal(connection, term);
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Opens an interactive PTY on a connected desktop computer (`device`, A96, A103).
 * - Linux/macOS: uses `pi-env` `openTerminal` over a dedicated device relay channel.
 * - Windows: uses the connector's native ConPTY channel (`pty_open` / `pty_resize`). */
export async function openDevicePty(links: DeviceLinks, deviceId: string, platform: string, options: PtyOpenOptions, onLog?: (text: string) => void): Promise<PtyHandle> {
  if (platform === "win32") {
    const pty = links.openNativePty(deviceId, options);
    if (!pty) throw new Error("Computer is offline or paused");
    return pty;
  }
  const connection = links.openTerminalConnection(deviceId, onLog);
  try {
    const term = await openTerminal(connection, {
      cwd: options.cwd,
      ...(options.argv ? { argv: options.argv } : {}),
      env: options.env,
      inheritEnv: true,
      cols: options.cols,
      rows: options.rows,
      onData: bytes => options.onData(Buffer.from(bytes)),
    });
    return wrapRemoteTerminal(connection, term);
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Opens an interactive PTY inside a remote Docker container or KVM VM hosted on a compute node (A108, A110). */
export async function openRemoteContainerPty(
  links: DeviceLinks,
  deviceId: string,
  container: string,
  options: PtyOpenOptions,
  onLog?: (text: string) => void,
  sandboxKind: "container" | "vm" = "container",
): Promise<PtyHandle> {
  const connection = links.openTerminalConnection(deviceId, onLog, container, sandboxKind);
  try {
    const term = await openTerminal(connection, {
      cwd: options.cwd,
      argv: options.argv ?? ["/bin/bash", "-l"],
      env: options.env,
      inheritEnv: true,
      cols: options.cols,
      rows: options.rows,
      onData: bytes => options.onData(Buffer.from(bytes)),
    });
    return wrapRemoteTerminal(connection, term);
  } catch (error) {
    connection.close();
    throw error;
  }
}
