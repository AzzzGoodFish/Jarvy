import { posix, win32 } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileError, FileInfo } from "@earendil-works/pi-durable/env";
import { Connection, RemoteError, RemoteExecutionEnv, isConnectionLost } from "@earendil-works/pi-env";
import { FsError, type EnvironmentFs, type FsDirPage, type FsEntry, type FsErrorCode, type FsReadHandle } from "../../shared/env-files.js";
import type { DeviceLinks } from "./device-link.js";

const DAEMON_DIR = "/opt/jarvy";
const DIR_PAGE_SIZE = 500;
/** Coalesce incoming HTTP stream chunks to 2 MiB so each write/append RPC pipelines multiple 512 KiB frames. */
const WRITE_BATCH_BYTES = 2 * 1024 * 1024;

/** Adapts any Pi Durable `ExecutionEnv` into Jarvy's transport-agnostic `EnvironmentFs` (A104). */
export function overExecutionEnvFs(
  id: string,
  env: ExecutionEnv,
  options: { cwd: string; home: string; separator: "/" | "\\"; close?: () => void | Promise<void> },
): EnvironmentFs {
  let closed = false;
  return {
    id,
    cwd: options.cwd,
    home: options.home,
    separator: options.separator,

    async listDir(path, maxEntries, signal): Promise<FsDirPage> {
      if (env instanceof RemoteExecutionEnv) {
        return listRemoteDir(env, path, maxEntries, options.separator, signal);
      }
      const ctx = context(signal);
      const reader = unwrap(await env.openDirReader(path, ctx));
      const entries: FsEntry[] = [];
      let truncated = false;
      try {
        while (entries.length <= maxEntries) {
          const want = Math.min(DIR_PAGE_SIZE, maxEntries + 1 - entries.length);
          const page = unwrap(await reader.next(want, ctx));
          for (const item of page.entries) {
            if (entries.length >= maxEntries) {
              truncated = true;
              break;
            }
            entries.push(toEntry(item));
          }
          if (page.done || truncated) break;
        }
      } finally {
        await reader.close(BACKGROUND_CONTEXT).catch(() => {});
      }
      return { entries, truncated };
    },

    async stat(path, signal): Promise<FsEntry> {
      return toEntry(unwrap(await env.fileInfo(path, context(signal))));
    },

    async realPath(path, signal): Promise<string> {
      return unwrap(await env.canonicalPath(path, context(signal)));
    },

    async exists(path, signal): Promise<boolean> {
      return unwrap(await env.exists(path, context(signal)));
    },

    async openRead(path, signal): Promise<FsReadHandle> {
      const ctx = context(signal);
      const reader = unwrap(await env.openBinaryReader(path, undefined, ctx));
      let info: FileInfo;
      try {
        info = unwrap(await reader.info(ctx));
      } catch (error) {
        await reader.close(BACKGROUND_CONTEXT).catch(() => {});
        throw error;
      }
      let handleClosed = false;
      return {
        size: info.size,
        name: info.name,
        async read(offset, length, readSignal) {
          return Buffer.from(unwrap(await reader.read(offset, length, context(readSignal))));
        },
        async close() {
          if (handleClosed) return;
          handleClosed = true;
          await reader.close(BACKGROUND_CONTEXT).catch(() => {});
        },
      };
    },

    async writeStream(path, chunks, signal): Promise<void> {
      const ctx = context(signal);
      let first = true;
      let pending: Buffer[] = [];
      let buffered = 0;

      const flush = async () => {
        if (!buffered) return;
        const payload = pending.length === 1 ? pending[0]! : Buffer.concat(pending, buffered);
        pending = [];
        buffered = 0;
        if (first) {
          first = false;
          unwrap(await env.writeFile(path, payload, ctx));
        } else {
          unwrap(await env.appendFile(path, payload, ctx));
        }
      };

      for await (const raw of chunks) {
        if (signal?.aborted) throw new FsError("aborted", "Upload aborted", path);
        if (!raw.byteLength) continue;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        pending.push(buf);
        buffered += buf.byteLength;
        if (buffered >= WRITE_BATCH_BYTES) await flush();
      }
      if (buffered > 0) await flush();
      else if (first) unwrap(await env.writeFile(path, new Uint8Array(0), ctx));
    },

    async mkdir(path, signal): Promise<void> {
      unwrap(await env.createDir(path, { recursive: true }, context(signal)));
    },

    async rename(from, to, signal): Promise<void> {
      unwrap(await env.renameFile(from, to, context(signal)));
    },

    async remove(path, recursive, signal): Promise<void> {
      unwrap(await env.remove(path, { recursive, force: false }, context(signal)));
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await options.close?.();
    },
  };
}

/** Opens a dedicated file-browser `EnvironmentFs` into a running Docker container sandbox (A104). */
export function openContainerFs(id: string, container: string, cwd: string, home: string, onLog?: (text: string) => void): EnvironmentFs {
  const connection = new Connection({
    command: ["docker", "exec", "-i", container, `${DAEMON_DIR}/pi-env`],
    ...(onLog ? { onLog: text => onLog(text.trim()) } : {}),
  });
  const env = new RemoteExecutionEnv({ connection, id: `files:computer:${id}`, cwd });
  return overExecutionEnvFs(id, env, { cwd, home, separator: "/", close: () => connection.close() });
}

/** Opens a dedicated file-browser `EnvironmentFs` onto a connected desktop computer (`device`, A104). */
export function openDeviceFs(
  links: DeviceLinks,
  id: string,
  cwd: string,
  home: string,
  separator: "/" | "\\",
  onLog?: (text: string) => void,
): EnvironmentFs {
  const connection = links.openConnection(id, onLog);
  const env = new RemoteExecutionEnv({ connection, id: `files:device:${id}`, cwd });
  return overExecutionEnvFs(id, env, { cwd, home, separator, close: () => connection.close() });
}

/** Opens a dedicated file-browser `EnvironmentFs` into a remote sandbox container or KVM VM on a compute node (A108, A110). */
export function openRemoteContainerFs(
  links: DeviceLinks,
  deviceId: string,
  envId: string,
  container: string,
  cwd: string,
  home: string,
  onLog?: (text: string) => void,
  sandboxKind: "container" | "vm" = "container",
): EnvironmentFs {
  const connection = links.openConnection(deviceId, onLog, container, sandboxKind);
  const env = new RemoteExecutionEnv({ connection, id: `files:remote-computer:${deviceId}:${container}`, cwd });
  return overExecutionEnvFs(envId, env, { cwd, home, separator: "/", close: () => connection.close() });
}

const context = (signal?: AbortSignal): Context => signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

interface WireDirEntry {
  name?: unknown;
  info?: { kind?: unknown; size?: unknown; mtimeSec?: unknown; mtimeNsec?: unknown };
  error?: { code?: unknown; message?: unknown };
}

/** Reads a remote directory directly via pi-env `opendir`/`readdir`/`close` frames so one entry whose metadata fails
 * (e.g. a reserved Windows name like `nul` returning `EISDIR`) is omitted instead of failing the entire page.
 * Directory-level errors (`opendir` failures, mid-read connection loss, or abort) still surface immediately. */
async function listRemoteDir(
  env: RemoteExecutionEnv,
  path: string,
  maxEntries: number,
  separator: "/" | "\\",
  signal?: AbortSignal,
): Promise<FsDirPage> {
  if (signal?.aborted) throw new FsError("aborted", "Listing aborted", path);
  const resolved = unwrap(await env.absolutePath(path, context(signal)));
  if (signal?.aborted) throw new FsError("aborted", "Listing aborted", resolved);
  const paths = separator === "\\" ? win32 : posix;
  let handle: unknown;
  let session: number;
  try {
    const opened = await env.connection.request("opendir", { path: resolved }, signal ? { signal } : {});
    handle = opened.json.handle;
    session = opened.session;
  } catch (error) {
    throw remoteErrorToFsError(error, resolved);
  }
  const entries: FsEntry[] = [];
  let truncated = false;
  let omitted = 0;
  try {
    while (entries.length <= maxEntries) {
      if (signal?.aborted) throw new FsError("aborted", "Listing aborted", resolved);
      const want = Math.min(DIR_PAGE_SIZE, maxEntries + 1 - entries.length);
      let reply: { json: Record<string, unknown> };
      try {
        reply = await env.connection.request("readdir", { handle, max: want }, { session, ...(signal ? { signal } : {}) });
      } catch (error) {
        throw remoteErrorToFsError(error, resolved);
      }
      if (signal?.aborted) throw new FsError("aborted", "Listing aborted", resolved);
      const rawEntries = Array.isArray(reply.json.entries) ? reply.json.entries as WireDirEntry[] : [];
      const done = reply.json.done === true;
      for (const item of rawEntries) {
        if (item.error !== undefined) {
          // Entry vanished between enumeration and lstat; no longer part of the directory.
          if (item.error.code === "ENOENT") continue;
          omitted++;
          continue;
        }
        const info = item.info;
        const name = typeof item.name === "string" ? item.name : "";
        if (!info || !name) {
          omitted++;
          continue;
        }
        const kind = info.kind;
        if (kind !== "file" && kind !== "directory" && kind !== "symlink") continue;
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        const mtimeSec = typeof info.mtimeSec === "number" ? info.mtimeSec : 0;
        const mtimeNsec = typeof info.mtimeNsec === "number" ? info.mtimeNsec : 0;
        entries.push({
          name,
          path: paths.resolve(resolved, name),
          kind,
          size: typeof info.size === "number" ? info.size : 0,
          mtimeMs: mtimeSec * 1000 + mtimeNsec / 1e6,
        });
      }
      if (done || truncated || !rawEntries.length) break;
    }
  } finally {
    await env.connection.request("close", { handle }, { session }).catch(() => {});
  }
  return { entries, truncated, ...(omitted > 0 ? { omitted } : {}) };
}

function remoteErrorToFsError(error: unknown, fallbackPath: string): FsError {
  if (error instanceof FsError) return error;
  if (isConnectionLost(error)) {
    return new FsError("connection_lost", error instanceof Error ? error.message : String(error), fallbackPath);
  }
  if (error instanceof RemoteError) {
    const path = error.path ?? fallbackPath;
    switch (error.code) {
      case "aborted": return new FsError("aborted", error.message, path);
      case "ENOENT": return new FsError("not_found", error.message, path);
      case "EACCES":
      case "EPERM": return new FsError("permission_denied", error.message, path);
      case "ENOTDIR": return new FsError("not_directory", error.message, path);
      case "EISDIR": return new FsError("is_directory", error.message, path);
      case "EINVAL":
      case "SYMLINK":
      case "NOT_REGULAR": return new FsError("invalid", error.message, path);
      default: return new FsError("unknown", error.message, path);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FsError("unknown", message, fallbackPath);
}

function toEntry(info: FileInfo): FsEntry {
  return { name: info.name, path: info.path, kind: info.kind, size: info.size, mtimeMs: info.mtimeMs };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: FileError }): T {
  if (result.ok) return result.value;
  throw toFsError(result.error);
}

function toFsError(error: FileError): FsError {
  if (isConnectionLost(error.cause) || isConnectionLost(error)) {
    return new FsError("connection_lost", error.message, error.path);
  }
  const map: Record<FileError["code"], FsErrorCode> = {
    not_found: "not_found",
    permission_denied: "permission_denied",
    not_directory: "not_directory",
    is_directory: "is_directory",
    invalid: "invalid",
    aborted: "aborted",
    not_supported: "invalid",
    unknown: "unknown",
  };
  return new FsError(map[error.code] ?? "unknown", error.message, error.path);
}
