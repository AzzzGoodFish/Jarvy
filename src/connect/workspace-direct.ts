import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/** Direct compute-node ↔ S3 Pre-signed URL workspace sync (A108).
 * Uses the exact same `JVY1` AES-256-GCM envelope format and `.jarvyignore` rules as Phase 2's server sync
 * so Bot workspace blobs flow straight between the compute node and S3 without traversing the lightweight VPS. */

const MAGIC = Buffer.from("JVY1", "ascii");
const FLAG_GZIP = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const TEMP_UPLOAD_PATTERN = /^\.jarvy-upload-[a-f0-9]+\.part$/;
const DEFAULT_IGNORES = new Set(["node_modules", ".venv", "venv", "__pycache__", "target", ".cache", "temp", ".DS_Store"]);

export interface DirectWorkspaceEntry {
  path: string;
  sha256: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface DirectWorkspaceManifest {
  version: 1;
  botId: string;
  rev: number;
  updatedAt: number;
  digest: string;
  files: DirectWorkspaceEntry[];
}

interface LocalWorkspaceMeta {
  rev: number;
  digest: string;
  updatedAt: number;
}

function encryptEnvelope(plain: Buffer, key: Buffer, objectKey: string): Buffer {
  let payload = plain;
  let flags = 0;
  if (plain.length >= 64) {
    const zipped = gzipSync(plain, { level: 6 });
    if (zipped.length < plain.length) { payload = zipped; flags |= FLAG_GZIP; }
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`jarvy-cloud:v1:${objectKey}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([flags]), iv, encrypted, cipher.getAuthTag()]);
}

function decryptEnvelope(envelope: Buffer, key: Buffer, objectKey: string): Buffer {
  if (envelope.length < HEADER_BYTES + TAG_BYTES || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`Corrupt cloud envelope for ${objectKey}`);
  }
  const flags = envelope[MAGIC.length]!;
  const iv = envelope.subarray(MAGIC.length + 1, HEADER_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(`jarvy-cloud:v1:${objectKey}`, "utf8"));
  decipher.setAuthTag(tag);
  const payload = Buffer.concat([decipher.update(envelope.subarray(HEADER_BYTES, envelope.length - TAG_BYTES)), decipher.final()]);
  return (flags & FLAG_GZIP) ? gunzipSync(payload) : payload;
}

async function loadIgnores(wsDir: string): Promise<Set<string>> {
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
  if (TEMP_UPLOAD_PATTERN.test(name) || relPosix.startsWith("recovered/")) return true;
  if (ignores.has(name) || ignores.has(relPosix)) return true;
  for (const seg of relPosix.split("/")) if (ignores.has(seg)) return true;
  return false;
}

export async function scanDirectWorkspace(wsDir: string): Promise<{ files: DirectWorkspaceEntry[]; digest: string }> {
  await mkdir(wsDir, { recursive: true, mode: 0o700 });
  const rootReal = await realpath(wsDir);
  const ignores = await loadIgnores(rootReal);
  const files: DirectWorkspaceEntry[] = [];

  const walk = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const full = join(dir, item.name);
      const rel = relative(rootReal, full).split(sep).join("/");
      if (isIgnored(rel, item.name, ignores) || item.isSymbolicLink()) continue;
      if (item.isDirectory()) { await walk(full); continue; }
      if (!item.isFile()) continue;
      const info = await lstat(full).catch(() => null);
      if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
      const bytes = await readFile(full).catch(() => null);
      if (!bytes) continue;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const mode = (info.mode & 0o111) ? 0o755 : 0o644;
      files.push({ path: rel, sha256, size: bytes.length, mode, mtimeMs: Math.round(info.mtimeMs) });
    }
  };
  await walk(rootReal);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const f of files) hash.update(`${f.path}\0${f.sha256}\0${f.mode}\n`);
  return { files, digest: hash.digest("hex") };
}

export async function readLocalWsMeta(metaPath: string): Promise<LocalWorkspaceMeta | null> {
  return readFile(metaPath, "utf8").then(t => JSON.parse(t) as LocalWorkspaceMeta).catch(() => null);
}

async function writeLocalWsMeta(metaPath: string, meta: LocalWorkspaceMeta): Promise<void> {
  await mkdir(dirname(metaPath), { recursive: true, mode: 0o700 });
  await writeFile(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

/** Pulls latest workspace directly from S3 Pre-signed URLs. Preserves unsynced divergent files in `recovered/<ts>/`. */
export async function pullDirectWorkspace(options: {
  wsDir: string;
  metaPath: string;
  rev: number;
  manifestKey: string;
  manifestUrl: string;
  blobGets: Record<string, { key: string; url: string }>;
  keyBase64: string;
}): Promise<{ skipped: boolean; rev: number; recovered: number }> {
  const { wsDir, metaPath, rev, manifestKey, manifestUrl, blobGets, keyBase64 } = options;
  const key = Buffer.from(keyBase64, "base64");
  const current = await scanDirectWorkspace(wsDir);
  const localMeta = await readLocalWsMeta(metaPath);
  if (localMeta && localMeta.rev === rev && localMeta.digest === current.digest) {
    return { skipped: true, rev, recovered: 0 };
  }

  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`Pre-signed manifest GET failed (${res.status})`);
  const manifest = JSON.parse(decryptEnvelope(Buffer.from(await res.arrayBuffer()), key, manifestKey).toString("utf8")) as DirectWorkspaceManifest;

  // Abnormal power-loss divergence guard: preserve dirty local files before applying newer cloud state.
  let recovered = 0;
  if (localMeta && localMeta.rev < rev && current.digest !== localMeta.digest && current.files.length > 0) {
    const incoming = new Map(manifest.files.map(f => [f.path, f.sha256]));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const f of current.files) {
      if (incoming.get(f.path) === f.sha256) continue;
      const dest = join(wsDir, "recovered", stamp, ...f.path.split("/"));
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await copyFile(join(wsDir, ...f.path.split("/")), dest).catch(() => {});
      recovered++;
    }
  }

  const rootReal = await realpath(wsDir);
  const wanted = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry.path || entry.path.startsWith("/") || entry.path.split("/").includes("..")) continue;
    wanted.add(entry.path);
    const dest = join(rootReal, ...entry.path.split("/"));
    const existing = await readFile(dest).catch(() => null);
    if (existing && createHash("sha256").update(existing).digest("hex") === entry.sha256) continue;
    const blobInfo = blobGets[entry.sha256];
    if (!blobInfo) throw new Error(`Missing pre-signed GET URL for workspace blob ${entry.sha256.slice(0, 12)}`);
    const blobRes = await fetch(blobInfo.url);
    if (!blobRes.ok) throw new Error(`Pre-signed blob GET failed (${blobRes.status})`);
    const plain = decryptEnvelope(Buffer.from(await blobRes.arrayBuffer()), key, blobInfo.key);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    const part = `${dest}.jarvy-pull.part`;
    await writeFile(part, plain, { mode: entry.mode || 0o644 });
    await chmod(part, entry.mode || 0o644);
    await rename(part, dest);
  }

  // Prune stale non-ignored files not present in the new manifest.
  const ignores = await loadIgnores(rootReal);
  const prune = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const full = join(dir, item.name);
      const rel = relative(rootReal, full).split(sep).join("/");
      if (isIgnored(rel, item.name, ignores)) continue;
      if (item.isDirectory()) {
        await prune(full);
        const left = await readdir(full).catch(() => []);
        if (!left.length) await rm(full, { recursive: true, force: true });
      } else if (!wanted.has(rel)) {
        await rm(full, { force: true });
      }
    }
  };
  await prune(rootReal);
  await writeLocalWsMeta(metaPath, { rev: manifest.rev, digest: manifest.digest, updatedAt: Date.now() });
  return { skipped: false, rev: manifest.rev, recovered };
}

/** Encrypts and uploads changed workspace blobs + manifest directly to S3 via Pre-signed PUT URLs. */
export async function pushDirectWorkspace(options: {
  wsDir: string;
  metaPath: string;
  botId: string;
  rev: number;
  manifestKey: string;
  manifestUrl: string;
  blobPuts: Record<string, { key: string; url: string }>;
  keyBase64: string;
}): Promise<{ rev: number; digest: string; uploadedBlobs: number }> {
  const { wsDir, metaPath, botId, rev, manifestKey, manifestUrl, blobPuts, keyBase64 } = options;
  const key = Buffer.from(keyBase64, "base64");
  const { files, digest } = await scanDirectWorkspace(wsDir);
  const byHash = new Map(files.map(f => [f.sha256, f]));

  let uploadedBlobs = 0;
  for (const [sha, target] of Object.entries(blobPuts)) {
    const entry = byHash.get(sha);
    if (!entry) continue;
    const plain = await readFile(join(wsDir, ...entry.path.split("/")));
    const envelope = encryptEnvelope(plain, key, target.key);
    const res = await fetch(target.url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(envelope) });
    if (!res.ok) throw new Error(`Pre-signed blob PUT failed (${res.status})`);
    uploadedBlobs++;
  }

  const manifest: DirectWorkspaceManifest = { version: 1, botId, rev, updatedAt: Date.now(), digest, files };
  const envManifest = encryptEnvelope(Buffer.from(JSON.stringify(manifest), "utf8"), key, manifestKey);
  const mRes = await fetch(manifestUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(envManifest) });
  if (!mRes.ok) throw new Error(`Pre-signed manifest PUT failed (${mRes.status})`);

  await writeLocalWsMeta(metaPath, { rev, digest, updatedAt: Date.now() });
  return { rev, digest, uploadedBlobs };
}
