/** Transport-agnostic filesystem abstraction for the Environments Files tab (A104).
 * Keeps `@earendil-works/pi-env` and execution transport details strictly inside `infra/env/` (A50). */

export type FsEntryKind = "file" | "directory" | "symlink";

export interface FsEntry {
  name: string;
  path: string;
  kind: FsEntryKind;
  size: number;
  mtimeMs: number;
}

export interface FsDirPage {
  entries: FsEntry[];
  truncated: boolean;
  /** Number of entries skipped because their metadata could not be read (e.g. Windows reserved names). */
  omitted?: number;
}

/** Long-lived positional reader for streaming downloads without per-chunk open/close overhead. */
export interface FsReadHandle {
  readonly size: number;
  readonly name: string;
  /** Reads up to `length` bytes starting at `offset` (empty Buffer at EOF). */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
}

export type FsErrorCode =
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "aborted"
  | "connection_lost"
  | "unknown";

export class FsError extends Error {
  constructor(readonly code: FsErrorCode, message: string, readonly path?: string) {
    super(message);
    this.name = "FsError";
  }
}

export interface EnvironmentFs {
  readonly id: string;
  readonly cwd: string;
  readonly home: string;
  readonly separator: "/" | "\\";
  listDir(path: string, maxEntries: number, signal?: AbortSignal): Promise<FsDirPage>;
  stat(path: string, signal?: AbortSignal): Promise<FsEntry>;
  realPath(path: string, signal?: AbortSignal): Promise<string>;
  exists(path: string, signal?: AbortSignal): Promise<boolean>;
  openRead(path: string, signal?: AbortSignal): Promise<FsReadHandle>;
  writeStream(path: string, chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  rename(from: string, to: string, signal?: AbortSignal): Promise<void>;
  remove(path: string, recursive: boolean, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
