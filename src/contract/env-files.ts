/** HTTP contract for the Environments file browser and direct transfer (A104). */

export type EnvFileKind = "file" | "directory" | "symlink";

export interface EnvFileEntry {
  name: string;
  /** Absolute path inside the environment (Windows `C:\...` on win32 devices, POSIX `/...` elsewhere). */
  path: string;
  kind: EnvFileKind;
  size: number;
  mtimeMs: number;
}

export interface EnvDirListing {
  environmentId: string;
  /** Current absolute directory path. */
  path: string;
  /** Parent directory path, or null at a filesystem root (`/`, `C:\`). */
  parent: string | null;
  /** Default working directory of this environment. */
  root: string;
  /** Home directory of this environment (used to expand `~`). */
  home: string;
  separator: "/" | "\\";
  entries: EnvFileEntry[];
  /** True when the directory had more entries than the listing cap. */
  truncated: boolean;
  /** Count of directory entries omitted because their metadata could not be read. */
  omitted?: number;
}

export interface EnvFileUploadResult {
  entry: EnvFileEntry;
}

/** Maximum entries returned for a single directory listing to keep the UI responsive. */
export const MAX_ENV_DIR_ENTRIES = 5000;
