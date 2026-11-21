import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileError, FileInfo } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv, isConnectionLost } from "@earendil-works/pi-env";
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

const context = (signal?: AbortSignal): Context => signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

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
