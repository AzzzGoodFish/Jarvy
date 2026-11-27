import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { FsError, type EnvironmentFs, type FsDirPage, type FsEntry, type FsErrorCode, type FsReadHandle } from "../../shared/env-files.js";
import type { WorkEnvironment } from "../../shared/environment.js";
import { COMPUTER_CWD } from "./docker.js";

/** Pure-Node jailed workspace engine (A106): serves `/workspace` file operations directly against
 * `bots/<botId>/workspace/` without requiring Docker or a VM. Strictly enforces path and symlink
 * containment inside the Bot's workspace root; only `exec` requires a sandbox runtime. */

export function normalizeWorkspacePath(input: string): string | null {
  if (!input || input.includes("\0")) return null;
  const resolved = posix.resolve(COMPUTER_CWD, input);
  if (resolved !== COMPUTER_CWD && !resolved.startsWith(`${COMPUTER_CWD}/`)) return null;
  return resolved;
}

export function isWorkspacePath(input: string): boolean {
  return normalizeWorkspacePath(input) !== null;
}

function insideRoot(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(`${realRoot}${sep}`);
}

function toVirtual(realRoot: string, hostPath: string): string {
  const rel = relative(realRoot, hostPath);
  if (!rel) return COMPUTER_CWD;
  return `${COMPUTER_CWD}/${rel.split(sep).join("/")}`;
}

async function ensureRoot(workspaceRoot: string): Promise<string> {
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  return realpath(workspaceRoot);
}

/** Resolves a virtual `/workspace/...` path to a host path strictly jailed inside `realRoot`.
 * When `followFinalSymlink` is true (reads/writes/mkdir/rename-dest), any existing symlink at the
 * target — including a dangling symlink — must resolve inside `realRoot` or is rejected. */
async function resolveJailed(
  workspaceRoot: string,
  input: string,
  options: { followFinalSymlink: boolean },
): Promise<{ realRoot: string; virtual: string; host: string }> {
  const virtual = normalizeWorkspacePath(input);
  if (!virtual) {
    throw new FsError("permission_denied", `Path must stay inside ${COMPUTER_CWD}: ${input}`, input);
  }
  const realRoot = await ensureRoot(workspaceRoot);
  const rel = virtual === COMPUTER_CWD ? "" : virtual.slice(COMPUTER_CWD.length + 1);
  const host = rel ? join(realRoot, ...rel.split("/")) : realRoot;

  // Verify the deepest existing ancestor stays inside `realRoot` (blocks intermediate symlink escapes).
  let probe = options.followFinalSymlink || host === realRoot ? host : dirname(host);
  while (true) {
    try {
      const resolved = await realpath(probe);
      if (!insideRoot(realRoot, resolved)) {
        throw new FsError("permission_denied", `Path escapes workspace: ${virtual}`, virtual);
      }
      break;
    } catch (error) {
      if (error instanceof FsError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw mapFsError(error, virtual);
      const parent = dirname(probe);
      if (parent === probe) {
        throw new FsError("permission_denied", `Path escapes workspace: ${virtual}`, virtual);
      }
      probe = parent;
    }
  }

  // Block dangling or escaping final symlinks when the caller will open/follow the target path.
  if (options.followFinalSymlink && host !== realRoot) {
    try {
      const info = await lstat(host);
      if (info.isSymbolicLink()) {
        const target = await realpath(host).catch(() => null);
        if (!target || !insideRoot(realRoot, target)) {
          throw new FsError("permission_denied", `Symlink escapes workspace: ${virtual}`, virtual);
        }
      }
    } catch (error) {
      if (error instanceof FsError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw mapFsError(error, virtual);
    }
  }

  return { realRoot, virtual, host };
}

function mapFsError(error: unknown, path: string): FsError {
  if (error instanceof FsError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const mapped: FsErrorCode = code === "ENOENT" ? "not_found"
    : code === "EACCES" || code === "EPERM" ? "permission_denied"
    : code === "ENOTDIR" ? "not_directory"
    : code === "EISDIR" ? "is_directory"
    : code === "EINVAL" || code === "ENAMETOOLONG" ? "invalid"
    : "unknown";
  return new FsError(mapped, message, path);
}

function entryKind(info: { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean }): FsEntry["kind"] | null {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return null;
}

/** Pure-Node `WorkEnvironment` jailed to `bots/<botId>/workspace/` mapped as `/workspace`. */
export function createWorkspaceEnvironment(
  id: string,
  workspaceRoot: string,
  execDenied: () => Error,
): WorkEnvironment {
  return {
    id,
    kind: "computer",
    local: false,
    cwd: COMPUTER_CWD,
    exec: async () => { throw execDenied(); },
    async readFile(path) {
      const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      return readFile(host);
    },
    async head(path, bytes) {
      const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      const handle = await open(host, "r");
      try {
        const buf = Buffer.alloc(Math.max(0, bytes));
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async readRange(path, offset, length) {
      const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      const handle = await open(host, "r");
      try {
        const buf = Buffer.alloc(Math.max(0, length));
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async writeFile(path, content) {
      const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      await mkdir(dirname(host), { recursive: true });
      await writeFile(host, content);
    },
    async appendFile(path, content) {
      const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      await mkdir(dirname(host), { recursive: true });
      await appendFile(host, content);
    },
    async mkdir(path) {
      const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      await mkdir(host, { recursive: true });
    },
    async exists(path) {
      try {
        const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
        await stat(host);
        return true;
      } catch {
        return false;
      }
    },
    async fileSize(path) {
      try {
        const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
        const info = await stat(host);
        return info.isFile() ? info.size : null;
      } catch {
        return null;
      }
    },
    async close() {},
  };
}

/** Pure-Node `EnvironmentFs` jailed to `bots/<botId>/workspace/` for the Environments → Files tab. */
export function openWorkspaceFs(id: string, workspaceRoot: string): EnvironmentFs {
  return {
    id,
    cwd: COMPUTER_CWD,
    home: COMPUTER_CWD,
    separator: "/",
    jailed: true,

    async listDir(path, maxEntries, signal): Promise<FsDirPage> {
      if (signal?.aborted) throw new FsError("aborted", "Listing aborted", path);
      const { virtual, host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      let names: string[];
      try {
        names = await readdir(host);
      } catch (error) {
        throw mapFsError(error, virtual);
      }
      const entries: FsEntry[] = [];
      let truncated = false;
      let omitted = 0;
      for (const name of names) {
        if (signal?.aborted) throw new FsError("aborted", "Listing aborted", virtual);
        const childHost = join(host, name);
        const childVirtual = virtual === COMPUTER_CWD ? `${COMPUTER_CWD}/${name}` : `${virtual}/${name}`;
        let info;
        try {
          info = await lstat(childHost);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          omitted++;
          continue;
        }
        const kind = entryKind(info);
        if (!kind) continue;
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        entries.push({ name, path: childVirtual, kind, size: kind === "file" ? info.size : 0, mtimeMs: info.mtimeMs });
      }
      return { entries, truncated, ...(omitted > 0 ? { omitted } : {}) };
    },

    async stat(path, signal): Promise<FsEntry> {
      if (signal?.aborted) throw new FsError("aborted", "Stat aborted", path);
      const { virtual, host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: false });
      try {
        const info = await lstat(host);
        const kind = entryKind(info);
        if (!kind) throw new FsError("invalid", `Unsupported file type: ${virtual}`, virtual);
        const name = virtual === COMPUTER_CWD ? "workspace" : posix.basename(virtual);
        return { name, path: virtual, kind, size: kind === "file" ? info.size : 0, mtimeMs: info.mtimeMs };
      } catch (error) {
        throw mapFsError(error, virtual);
      }
    },

    async realPath(path, signal): Promise<string> {
      if (signal?.aborted) throw new FsError("aborted", "Realpath aborted", path);
      const { realRoot, virtual, host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      try {
        const resolved = await realpath(host);
        if (!insideRoot(realRoot, resolved)) {
          throw new FsError("permission_denied", `Path escapes workspace: ${virtual}`, virtual);
        }
        return toVirtual(realRoot, resolved);
      } catch (error) {
        throw mapFsError(error, virtual);
      }
    },

    async exists(path, signal): Promise<boolean> {
      if (signal?.aborted) throw new FsError("aborted", "Exists aborted", path);
      try {
        const { host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: false });
        await lstat(host);
        return true;
      } catch {
        return false;
      }
    },

    async openRead(path, signal): Promise<FsReadHandle> {
      if (signal?.aborted) throw new FsError("aborted", "Download aborted", path);
      const { virtual, host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      let handle;
      let info;
      try {
        handle = await open(host, "r");
        info = await handle.stat();
      } catch (error) {
        await handle?.close().catch(() => {});
        throw mapFsError(error, virtual);
      }
      if (!info.isFile()) {
        await handle.close().catch(() => {});
        throw new FsError(info.isDirectory() ? "is_directory" : "invalid", `Not a regular file: ${virtual}`, virtual);
      }
      let closed = false;
      return {
        size: info.size,
        name: posix.basename(virtual),
        async read(offset, length, readSignal) {
          if (readSignal?.aborted) throw new FsError("aborted", "Download aborted", virtual);
          const buf = Buffer.alloc(Math.max(0, length));
          try {
            const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
            return buf.subarray(0, bytesRead);
          } catch (error) {
            throw mapFsError(error, virtual);
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          await handle.close().catch(() => {});
        },
      };
    },

    async writeStream(path, chunks, signal): Promise<void> {
      if (signal?.aborted) throw new FsError("aborted", "Upload aborted", path);
      const { virtual, host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      await mkdir(dirname(host), { recursive: true });
      let handle;
      try {
        handle = await open(host, "w");
        for await (const chunk of chunks) {
          if (signal?.aborted) throw new FsError("aborted", "Upload aborted", virtual);
          if (!chunk.byteLength) continue;
          await handle.write(chunk);
        }
      } catch (error) {
        throw mapFsError(error, virtual);
      } finally {
        await handle?.close().catch(() => {});
      }
    },

    async mkdir(path, signal): Promise<void> {
      if (signal?.aborted) throw new FsError("aborted", "Mkdir aborted", path);
      const { virtual, host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: true });
      try {
        await mkdir(host, { recursive: true });
      } catch (error) {
        throw mapFsError(error, virtual);
      }
    },

    async rename(from, to, signal): Promise<void> {
      if (signal?.aborted) throw new FsError("aborted", "Rename aborted", from);
      const src = await resolveJailed(workspaceRoot, from, { followFinalSymlink: false });
      const dst = await resolveJailed(workspaceRoot, to, { followFinalSymlink: true });
      if (src.virtual === COMPUTER_CWD || dst.virtual === COMPUTER_CWD) {
        throw new FsError("invalid", "Cannot rename workspace root", from);
      }
      try {
        await rename(src.host, dst.host);
      } catch (error) {
        throw mapFsError(error, src.virtual);
      }
    },

    async remove(path, recursive, signal): Promise<void> {
      if (signal?.aborted) throw new FsError("aborted", "Remove aborted", path);
      const { virtual, host } = await resolveJailed(workspaceRoot, path, { followFinalSymlink: false });
      if (virtual === COMPUTER_CWD) {
        throw new FsError("invalid", "Cannot remove workspace root", virtual);
      }
      try {
        await rm(host, { recursive, force: false });
      } catch (error) {
        throw mapFsError(error, virtual);
      }
    },

    async close(): Promise<void> {},
  };
}
