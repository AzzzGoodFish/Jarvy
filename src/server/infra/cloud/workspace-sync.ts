import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { decryptEnvelope, encryptEnvelope } from "./crypto.js";
import type { S3Client } from "./s3-client.js";

/** Content-addressed incremental sync for Bot workspaces (`bots/<botId>/workspace/`, A107).
 * Uses deduplicated encrypted blobs under `workspaces/blobs/<ab>/<sha256>.enc` and per-Bot manifests
 * `workspaces/<botId>/manifest-r<rev>.json.enc` so both Phase 2 server sync and Phase 3 compute nodes
 * share the exact same `workspace_rev` versioning model. */

export interface WorkspaceFileEntry {
  path: string;
  sha256: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface WorkspaceManifest {
  version: 1;
  botId: string;
  rev: number;
  updatedAt: number;
  digest: string;
  files: WorkspaceFileEntry[];
}

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".cache",
  "temp",
  ".DS_Store",
]);

/** Skip individual files larger than 100 MiB during automatic background workspace sync. */
const MAX_WORKSPACE_FILE_BYTES = 100 * 1024 * 1024;
const TEMP_UPLOAD_PATTERN = /^\.jarvy-upload-[a-f0-9]+\.part$/;

function blobKey(prefix: string, sha256: string): string {
  return `${prefix}workspaces/blobs/${sha256.slice(0, 2)}/${sha256}.enc`;
}

export function manifestKey(prefix: string, botId: string, rev: number): string {
  return `${prefix}workspaces/${botId}/manifest-r${rev}.json.enc`;
}

async function loadIgnoreRules(wsDir: string): Promise<Set<string>> {
  const rules = new Set(DEFAULT_IGNORES);
  const text = await readFile(join(wsDir, ".jarvyignore"), "utf8").catch(() => "");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\/+$/, "");
    if (!line || line.startsWith("#")) continue;
    rules.add(line);
  }
  return rules;
}

function isIgnored(relPosix: string, name: string, ignores: Set<string>): boolean {
  if (TEMP_UPLOAD_PATTERN.test(name)) return true;
  if (ignores.has(name) || ignores.has(relPosix)) return true;
  for (const seg of relPosix.split("/")) {
    if (ignores.has(seg)) return true;
  }
  return false;
}

async function scanWorkspace(wsDir: string): Promise<WorkspaceFileEntry[]> {
  let rootReal: string;
  try {
    rootReal = await realpath(wsDir);
  } catch {
    return [];
  }
  const ignores = await loadIgnoreRules(rootReal);
  const out: WorkspaceFileEntry[] = [];

  const walk = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const full = join(dir, item.name);
      const rel = relative(rootReal, full).split(sep).join("/");
      if (isIgnored(rel, item.name, ignores)) continue;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size > MAX_WORKSPACE_FILE_BYTES) continue;
      const bytes = await readFile(full).catch(() => null);
      if (!bytes) continue;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const mode = (info.mode & 0o111) ? 0o755 : 0o644;
      out.push({ path: rel, sha256, size: bytes.length, mode, mtimeMs: Math.round(info.mtimeMs) });
    }
  };

  await walk(rootReal);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function computeDigest(files: readonly WorkspaceFileEntry[]): string {
  const hash = createHash("sha256");
  for (const f of files) hash.update(`${f.path}\0${f.sha256}\0${f.mode}\n`);
  return hash.digest("hex");
}

export async function syncWorkspaceUp(options: {
  s3: S3Client;
  key: Buffer;
  prefix: string;
  botId: string;
  localDir: string;
  prevRev: number;
  prevDigest: string | null;
  knownBlobs: Set<string>;
  assertHeld: () => void;
}): Promise<{ changed: boolean; rev: number; digest: string; manifest: string | null; uploadedBlobs: number }> {
  const { s3, key, prefix, botId, localDir, prevRev, prevDigest, knownBlobs, assertHeld } = options;
  const files = await scanWorkspace(localDir);
  const digest = computeDigest(files);
  if (prevDigest && digest === prevDigest) {
    return { changed: false, rev: prevRev, digest, manifest: prevRev > 0 ? manifestKey(prefix, botId, prevRev) : null, uploadedBlobs: 0 };
  }

  let uploadedBlobs = 0;
  for (const entry of files) {
    assertHeld();
    if (knownBlobs.has(entry.sha256)) continue;
    const targetKey = blobKey(prefix, entry.sha256);
    const exists = await s3.head(targetKey);
    if (!exists) {
      const plain = await readFile(join(localDir, ...entry.path.split("/")));
      const envelope = encryptEnvelope(plain, key, targetKey, true);
      await s3.put(targetKey, envelope);
      uploadedBlobs++;
    }
    knownBlobs.add(entry.sha256);
  }

  assertHeld();
  const rev = prevRev + 1;
  const mKey = manifestKey(prefix, botId, rev);
  const manifest: WorkspaceManifest = { version: 1, botId, rev, updatedAt: Date.now(), digest, files };
  await s3.put(mKey, encryptEnvelope(Buffer.from(JSON.stringify(manifest), "utf8"), key, mKey, true));
  return { changed: true, rev, digest, manifest: mKey, uploadedBlobs };
}

export async function restoreWorkspaceDown(options: {
  s3: S3Client;
  key: Buffer;
  prefix: string;
  manifestObjectKey: string;
  localDir: string;
}): Promise<WorkspaceManifest | null> {
  const { s3, key, prefix, manifestObjectKey, localDir } = options;
  const res = await s3.get(manifestObjectKey);
  if (!res) return null;
  const manifest = JSON.parse(decryptEnvelope(res.body, key, manifestObjectKey).toString("utf8")) as WorkspaceManifest;
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const rootReal = await realpath(localDir);
  const wanted = new Set<string>();

  for (const entry of manifest.files) {
    if (!entry.path || entry.path.startsWith("/") || entry.path.split("/").includes("..")) continue;
    wanted.add(entry.path);
    const dest = join(rootReal, ...entry.path.split("/"));
    // Skip re-downloading if local file already matches exact SHA-256.
    const existing = await readFile(dest).catch(() => null);
    if (existing && createHash("sha256").update(existing).digest("hex") === entry.sha256) continue;
    const bKey = blobKey(prefix, entry.sha256);
    const blob = await s3.get(bKey);
    if (!blob) throw new Error(`Missing workspace blob ${bKey} referenced by ${manifestObjectKey}`);
    const plain = decryptEnvelope(blob.body, key, bKey);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    const part = `${dest}.jarvy-restore.part`;
    await writeFile(part, plain, { mode: entry.mode || 0o644 });
    await chmod(part, entry.mode || 0o644);
    await rename(part, dest);
  }

  // Clean up stale non-ignored files from an older local copy so restored workspace matches the manifest cleanly.
  const ignores = await loadIgnoreRules(rootReal);
  const prune = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const full = join(dir, item.name);
      const rel = relative(rootReal, full).split(sep).join("/");
      if (isIgnored(rel, item.name, ignores)) continue;
      if (item.isDirectory()) {
        await prune(full);
        const remaining = await readdir(full).catch(() => []);
        if (!remaining.length) await rm(full, { recursive: true, force: true });
      } else if (!wanted.has(rel)) {
        await rm(full, { force: true });
      }
    }
  };
  await prune(rootReal);
  return manifest;
}
