import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import { MAX_ENV_DIR_ENTRIES, type EnvDirListing, type EnvFileEntry, type EnvFileUploadResult } from "../../contract/env-files.js";
import { ChatError } from "../shared/chat.js";
import { FsError, type EnvironmentFs, type FsEntry } from "../shared/env-files.js";

const IDLE_TTL_MS = 5 * 60_000;
const REAP_INTERVAL_MS = 60_000;
/** Pull-based HTTP download chunk size (1 MiB; underlying reader pipelines reads inside). */
const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export interface EnvFileDependencies {
  verifyReady(environmentId: string): string;
  openFs(environmentId: string): Promise<EnvironmentFs>;
}

interface PooledFs {
  signature: string;
  fsPromise: Promise<EnvironmentFs>;
  lastUsed: number;
  inUse: number;
  evicted: boolean;
}

/** Manages pooled file-browser connections and direct streaming file operations across all work environments (A104).
 * Completely transport-agnostic: depends only on `EnvironmentFs` in `shared/env-files.ts`. */
export class EnvFileService {
  private readonly pool = new Map<string, PooledFs>();
  private readonly reaper: NodeJS.Timeout;

  constructor(private readonly deps: EnvFileDependencies) {
    this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  async list(environmentId: string, rawPath?: string, signal?: AbortSignal): Promise<EnvDirListing> {
    return this.withFs(environmentId, async fs => {
      const target = rawPath ? normalizePath(rawPath, fs.home, fs.separator) : normalizePath(fs.cwd, fs.home, fs.separator);
      const info = await fs.stat(target, signal);
      let dirPath = target;
      if (info.kind === "symlink") {
        const real = normalizePath(await fs.realPath(target, signal), fs.home, fs.separator);
        const resolvedInfo = await fs.stat(real, signal);
        if (resolvedInfo.kind !== "directory") throw new ChatError(400, "Not a directory", "file_not_directory");
        dirPath = target;
      } else if (info.kind !== "directory") {
        throw new ChatError(400, "Not a directory", "file_not_directory");
      }
      const page = await fs.listDir(dirPath, MAX_ENV_DIR_ENTRIES, signal);
      const root = normalizePath(fs.cwd, fs.home, fs.separator);
      return {
        environmentId,
        path: dirPath,
        parent: fs.jailed && dirPath === root ? null : parentOf(dirPath, fs.separator),
        root,
        home: normalizePath(fs.home, fs.home, fs.separator),
        separator: fs.separator,
        entries: page.entries.map(item => toContractEntry(item, fs.separator)),
        truncated: page.truncated,
        ...(page.omitted ? { omitted: page.omitted } : {}),
      };
    });
  }

  /** Opens a pull-based streaming download for a regular file (or symlink to a regular file). */
  async openDownload(
    environmentId: string,
    rawPath: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; size: number; stream: ReadableStream<Uint8Array> }> {
    if (!rawPath) throw new ChatError(400, "File path is required", "file_invalid_path");
    const entry = this.acquire(environmentId);
    try {
      const fs = await entry.fsPromise;
      const requested = normalizePath(rawPath, fs.home, fs.separator);
      const info = await fs.stat(requested, signal);
      let targetPath = requested;
      if (info.kind === "symlink") {
        const real = normalizePath(await fs.realPath(requested, signal), fs.home, fs.separator);
        const resolvedInfo = await fs.stat(real, signal);
        if (resolvedInfo.kind === "directory") throw new ChatError(400, "Cannot download a directory", "file_is_directory");
        targetPath = real;
      } else if (info.kind === "directory") {
        throw new ChatError(400, "Cannot download a directory", "file_is_directory");
      }

      const handle = await fs.openRead(targetPath, signal);
      const size = handle.size;
      const name = baseOf(requested, fs.separator) || handle.name || "download";
      let offset = 0;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        entry.inUse = Math.max(0, entry.inUse - 1);
        entry.lastUsed = Date.now();
        void handle.close().catch(() => {});
      };

      const evictOnLost = () => this.evict(environmentId, entry);
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            release();
            controller.close();
            return;
          }
          try {
            const chunk = await handle.read(offset, DOWNLOAD_CHUNK_BYTES, signal);
            if (!chunk.byteLength) {
              release();
              controller.close();
              return;
            }
            offset += chunk.byteLength;
            controller.enqueue(chunk);
          } catch (error) {
            release();
            if (error instanceof FsError && error.code === "connection_lost") evictOnLost();
            controller.error(error);
          }
        },
        cancel() {
          release();
        },
      });
      return { name, size, stream };
    } catch (error) {
      entry.inUse = Math.max(0, entry.inUse - 1);
      entry.lastUsed = Date.now();
      throw this.handleError(environmentId, entry, error);
    }
  }

  /** Streams an uploaded file into a sibling temporary file and atomically renames it into place. */
  async upload(
    environmentId: string,
    rawDir: string,
    rawName: string,
    chunks: AsyncIterable<Uint8Array>,
    options: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<EnvFileUploadResult> {
    return this.withFs(environmentId, async fs => {
      const name = validateEntryName(rawName, fs.separator);
      const dir = rawDir ? normalizePath(rawDir, fs.home, fs.separator) : normalizePath(fs.cwd, fs.home, fs.separator);
      await ensureDirectory(fs, dir, options.signal);
      const destPath = joinPath(dir, name, fs.separator);
      const existing = await tryStat(fs, destPath, options.signal);
      if (existing?.kind === "directory") throw new ChatError(400, "Cannot overwrite a directory", "file_is_directory");
      if (existing && !options.overwrite) throw new ChatError(409, "A file with this name already exists", "file_already_exists");

      const tempName = `.jarvy-upload-${randomBytes(6).toString("hex")}.part`;
      const tempPath = joinPath(dir, tempName, fs.separator);
      try {
        await fs.writeStream(tempPath, chunks, options.signal);
        const current = await tryStat(fs, destPath, options.signal);
        if (current?.kind === "directory") throw new ChatError(400, "Cannot overwrite a directory", "file_is_directory");
        if (current && !options.overwrite) throw new ChatError(409, "A file with this name already exists", "file_already_exists");
        await fs.rename(tempPath, destPath, options.signal);
        const saved = await fs.stat(destPath, options.signal);
        return { entry: toContractEntry(saved, fs.separator) };
      } catch (error) {
        await fs.remove(tempPath, false).catch(() => {});
        throw error;
      }
    });
  }

  async mkdir(environmentId: string, rawParent: string, rawName: string, signal?: AbortSignal): Promise<EnvFileEntry> {
    return this.withFs(environmentId, async fs => {
      const name = validateEntryName(rawName, fs.separator);
      const parent = rawParent ? normalizePath(rawParent, fs.home, fs.separator) : normalizePath(fs.cwd, fs.home, fs.separator);
      await ensureDirectory(fs, parent, signal);
      const target = joinPath(parent, name, fs.separator);
      if (await fs.exists(target, signal)) throw new ChatError(409, "A file or folder with this name already exists", "file_already_exists");
      await fs.mkdir(target, signal);
      return toContractEntry(await fs.stat(target, signal), fs.separator);
    });
  }

  async rename(environmentId: string, rawPath: string, rawName: string, signal?: AbortSignal): Promise<EnvFileEntry> {
    if (!rawPath) throw new ChatError(400, "Path is required", "file_invalid_path");
    return this.withFs(environmentId, async fs => {
      const name = validateEntryName(rawName, fs.separator);
      const source = normalizePath(rawPath, fs.home, fs.separator);
      const parent = parentOf(source, fs.separator);
      if (parent === null) throw new ChatError(400, "Cannot rename the root directory", "file_invalid_path");
      await fs.stat(source, signal);
      const dest = joinPath(parent, name, fs.separator);
      if (dest === source) return toContractEntry(await fs.stat(source, signal), fs.separator);
      if (await fs.exists(dest, signal)) throw new ChatError(409, "A file or folder with this name already exists", "file_already_exists");
      await fs.rename(source, dest, signal);
      return toContractEntry(await fs.stat(dest, signal), fs.separator);
    });
  }

  async remove(environmentId: string, rawPath: string, signal?: AbortSignal): Promise<void> {
    if (!rawPath) throw new ChatError(400, "Path is required", "file_invalid_path");
    return this.withFs(environmentId, async fs => {
      const target = normalizePath(rawPath, fs.home, fs.separator);
      if (parentOf(target, fs.separator) === null) throw new ChatError(400, "Cannot delete the root directory", "file_invalid_path");
      // lstat: symlinks to directories have kind === "symlink" and are unlinked without touching target contents.
      const info = await fs.stat(target, signal);
      await fs.remove(target, info.kind === "directory", signal);
    });
  }

  closeForEnvironment(environmentId: string): void {
    const entry = this.pool.get(environmentId);
    if (!entry) return;
    this.evict(environmentId, entry);
  }

  closeAll(): void {
    clearInterval(this.reaper);
    for (const [id, entry] of [...this.pool.entries()]) this.evict(id, entry);
  }

  private acquire(environmentId: string): PooledFs {
    if (!environmentId || typeof environmentId !== "string") {
      throw new ChatError(400, "environmentId is required", "file_invalid_path");
    }
    let signature: string;
    try {
      signature = this.deps.verifyReady(environmentId);
    } catch (error) {
      this.closeForEnvironment(environmentId);
      throw error;
    }
    let entry = this.pool.get(environmentId);
    if (entry && (entry.evicted || entry.signature !== signature)) {
      this.evict(environmentId, entry);
      entry = undefined;
    }
    if (!entry) {
      const created: PooledFs = {
        signature,
        fsPromise: this.deps.openFs(environmentId),
        lastUsed: Date.now(),
        inUse: 0,
        evicted: false,
      };
      created.fsPromise.catch(() => {
        if (this.pool.get(environmentId) === created) this.pool.delete(environmentId);
      });
      this.pool.set(environmentId, created);
      entry = created;
    }
    entry.inUse++;
    entry.lastUsed = Date.now();
    return entry;
  }

  private async withFs<T>(environmentId: string, work: (fs: EnvironmentFs) => Promise<T>): Promise<T> {
    const entry = this.acquire(environmentId);
    try {
      const fs = await entry.fsPromise;
      return await work(fs);
    } catch (error) {
      throw this.handleError(environmentId, entry, error);
    } finally {
      entry.inUse = Math.max(0, entry.inUse - 1);
      entry.lastUsed = Date.now();
    }
  }

  private handleError(environmentId: string, entry: PooledFs, error: unknown): unknown {
    if (error instanceof FsError) {
      if (error.code === "connection_lost") {
        this.evict(environmentId, entry);
        return new ChatError(409, "Connection to environment was lost; please retry");
      }
      if (error.code === "not_found") return new ChatError(404, "File or directory not found", "file_not_found");
      if (error.code === "permission_denied") return new ChatError(403, "Permission denied", "file_permission_denied");
      if (error.code === "not_directory") return new ChatError(400, "Not a directory", "file_not_directory");
      if (error.code === "is_directory") return new ChatError(400, "Path is a directory", "file_is_directory");
      if (error.code === "invalid") return new ChatError(400, "Invalid file path", "file_invalid_path");
      if (error.code === "aborted") return new ChatError(400, "Operation cancelled");
      return new ChatError(409, error.message || "File operation failed");
    }
    return error;
  }

  private evict(environmentId: string, entry: PooledFs): void {
    entry.evicted = true;
    if (this.pool.get(environmentId) === entry) this.pool.delete(environmentId);
    void entry.fsPromise.then(fs => fs.close()).catch(() => {});
  }

  private reapIdle(): void {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [id, entry] of [...this.pool.entries()]) {
      if (entry.inUse === 0 && entry.lastUsed < cutoff) this.evict(id, entry);
    }
  }
}

async function ensureDirectory(fs: EnvironmentFs, dir: string, signal?: AbortSignal): Promise<void> {
  const info = await fs.stat(dir, signal);
  if (info.kind === "directory") return;
  if (info.kind === "symlink") {
    const real = await fs.realPath(dir, signal);
    const resolved = await fs.stat(real, signal);
    if (resolved.kind === "directory") return;
  }
  throw new ChatError(400, "Not a directory", "file_not_directory");
}

async function tryStat(fs: EnvironmentFs, path: string, signal?: AbortSignal): Promise<FsEntry | null> {
  try { return await fs.stat(path, signal); }
  catch (error) {
    if (error instanceof FsError && error.code === "not_found") return null;
    throw error;
  }
}

function validateEntryName(raw: unknown, sep: "/" | "\\"): string {
  if (typeof raw !== "string" || !raw) throw new ChatError(400, "File name is required", "file_invalid_path");
  // Preserve exact characters instead of trimming, and explicitly reject unsupported names.
  if (!raw.trim() || raw === "." || raw === ".." || raw.length > 255 || raw.includes("/") || raw.includes("\\") || CONTROL_CHARS.test(raw)) {
    throw new ChatError(400, "Invalid file or folder name", "file_invalid_path");
  }
  if (sep === "\\" && (/[ .]$/.test(raw) || /[<>:"|?*]/.test(raw))) {
    throw new ChatError(400, "Invalid Windows file or folder name", "file_invalid_path");
  }
  return raw;
}

function normalizePath(raw: string, home: string, sep: "/" | "\\"): string {
  // Never trim: leading/trailing spaces are valid POSIX path characters and trimming can retarget a sibling entry.
  if (!raw || CONTROL_CHARS.test(raw)) throw new ChatError(400, "Invalid file path", "file_invalid_path");
  if (sep === "\\") {
    let text = raw;
    if (text === "~") text = home;
    else if (text.startsWith("~/") || text.startsWith("~\\")) text = `${home}\\${text.slice(2)}`;
    // Accept Git Bash-style `/c/Users/...` paths on Windows devices too.
    const gitBash = /^\/([A-Za-z])(\/.*)?$/.exec(text);
    if (gitBash) text = `${gitBash[1]!.toUpperCase()}:${gitBash[2] ?? "\\"}`;
    text = text.replaceAll("/", "\\");
    if (/^[A-Za-z]:$/.test(text)) text = `${text}\\`;
    if (!/^[A-Za-z]:\\/.test(text)) throw new ChatError(400, "Path must be absolute", "file_invalid_path");
    const norm = win32.normalize(text);
    return norm.length > 3 && norm.endsWith("\\") ? norm.slice(0, -1) : norm;
  }
  let text = raw;
  if (text === "~") text = home;
  else if (text.startsWith("~/")) text = `${home}/${text.slice(2)}`;
  if (!text.startsWith("/")) throw new ChatError(400, "Path must be absolute", "file_invalid_path");
  const norm = posix.normalize(text);
  return norm.length > 1 && norm.endsWith("/") ? norm.slice(0, -1) : norm;
}

function parentOf(path: string, sep: "/" | "\\"): string | null {
  if (sep === "\\") {
    const p = win32.dirname(path);
    return p === path ? null : p;
  }
  const p = posix.dirname(path);
  return p === path ? null : p;
}

function joinPath(dir: string, name: string, sep: "/" | "\\"): string {
  return sep === "\\" ? win32.join(dir, name) : posix.join(dir, name);
}

function baseOf(path: string, sep: "/" | "\\"): string {
  return sep === "\\" ? win32.basename(path) : posix.basename(path);
}

function toContractEntry(entry: FsEntry, sep: "/" | "\\"): EnvFileEntry {
  const path = sep === "\\" ? entry.path.replaceAll("/", "\\") : entry.path;
  return { name: entry.name, path, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs };
}
