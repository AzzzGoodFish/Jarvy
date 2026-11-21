import type { EnvFileEntry } from "../../contract/env-files";

export type SortKey = "name" | "size" | "mtime";
export type SortDir = "asc" | "desc";

export interface Breadcrumb {
  label: string;
  path: string;
}

/** Splits an absolute POSIX or Windows path into clickable breadcrumb segments. */
export function splitBreadcrumbs(path: string, separator: "/" | "\\"): Breadcrumb[] {
  if (!path) return [];
  if (separator === "\\") {
    const drive = /^([A-Za-z]:\\)(.*)$/.exec(path);
    if (!drive) return [{ label: path, path }];
    const root = drive[1]!;
    const rest = drive[2]!.split("\\").filter(Boolean);
    const items: Breadcrumb[] = [{ label: root, path: root }];
    let current = root;
    for (const part of rest) {
      current = current.endsWith("\\") ? `${current}${part}` : `${current}\\${part}`;
      items.push({ label: part, path: current });
    }
    return items;
  }
  const parts = path.split("/").filter(Boolean);
  const items: Breadcrumb[] = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    items.push({ label: part, path: current });
  }
  return items;
}

/** Formats byte counts into compact human-readable sizes. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[idx]}`;
}

/** Formats a file modification timestamp compactly for the current locale. */
export function formatFileTime(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return "—";
  const date = new Date(mtimeMs);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleString(undefined, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Sorts directory entries with directories always listed before files and symlinks. */
export function sortEntries(entries: readonly EnvFileEntry[], key: SortKey, dir: SortDir): EnvFileEntry[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const aDir = a.kind === "directory" ? 0 : 1;
    const bDir = b.kind === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    if (key === "size") {
      if (a.size !== b.size) return (a.size - b.size) * factor;
    } else if (key === "mtime") {
      if (a.mtimeMs !== b.mtimeMs) return (a.mtimeMs - b.mtimeMs) * factor;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * factor;
  });
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"]);
const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "sh", "bash", "zsh", "ps1", "json", "yaml", "yml", "toml", "xml", "html", "css", "scss", "sql", "rb", "php", "kt", "swift"]);
const TEXT_EXT = new Set(["md", "txt", "log", "csv", "ini", "cfg", "conf", "env", "pdf", "doc", "docx"]);

export type FileVisualKind = "directory" | "symlink" | "image" | "archive" | "code" | "text" | "file";

export function fileVisualKind(entry: Pick<EnvFileEntry, "kind" | "name">): FileVisualKind {
  if (entry.kind === "directory") return "directory";
  if (entry.kind === "symlink") return "symlink";
  const dot = entry.name.lastIndexOf(".");
  if (dot <= 0) return "file";
  const ext = entry.name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  return "file";
}

/** Selection end index when renaming a file so only the stem (before extension) is selected. */
export function renameSelectionEnd(entry: Pick<EnvFileEntry, "kind" | "name">): number {
  if (entry.kind === "directory") return entry.name.length;
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? dot : entry.name.length;
}

/** Copies text to the clipboard over HTTPS (`navigator.clipboard`) and plain-HTTP LAN (`execCommand`). */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback below */ }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(textarea);
  return ok;
}
