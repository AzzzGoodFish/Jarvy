import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

/** Where an attachment's bytes live under `root` (`<data>/attachments`): one folder per first two characters of the
 * id, so no folder grows past a few hundred entries. */
export const attachmentPath = (root: string, id: string) => join(root, id.slice(0, 2), id);
/** Files on their way in: written here first, moved into place once whole. */
const INCOMING = "incoming";
const SHARD = /^[a-f\d]{2}$/;
const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;

/** A file written under a new id and not yet in place: `commit` moves it there, `discard` drops it. */
export interface StagedFile { id: string; size: number; sha256: string; }
export class FileTooLarge extends Error { constructor() { super("File is too large"); } }

/** The bytes of chat attachments (A66): one file each in the data directory, named by the attachment's id. The
 * database keeps what the attachment is (name, type, size, message); this keeps its contents. Files come in as a
 * stream, so no file is held in memory whole. */
export class AttachmentFiles {
  readonly root: string;
  constructor(dataDir: string) { this.root = join(dataDir, "attachments"); }

  /** Writes `chunks` to a new file under a new id; past `limit` bytes it stops and throws FileTooLarge. Nothing is
   * left behind when it throws. */
  async stage(chunks: AsyncIterable<Uint8Array>, limit: number, signal?: AbortSignal): Promise<StagedFile> {
    const id = randomUUID(), part = this.part(id), hash = createHash("sha256");
    await mkdir(dirname(part), { recursive: true, mode: 0o700 });
    const handle = await open(part, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of chunks) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > limit) throw new FileTooLarge();
        hash.update(chunk);
        for (let written = 0; written < chunk.length;) written += (await handle.write(chunk, written)).bytesWritten;
      }
      signal?.throwIfAborted();
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(part, { force: true });
      throw error;
    }
    await handle.close();
    return { id, size, sha256: hash.digest("hex") };
  }
  /** Moves a staged file into place. */
  async commit(id: string): Promise<void> {
    const target = this.path(id);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(this.part(id), target);
  }
  /** Drops files, staged or in place; ids with no file are skipped. */
  async discard(ids: readonly string[]): Promise<void> {
    for (const id of ids) if (ID.test(id)) await Promise.all([rm(this.part(id), { force: true }), rm(this.path(id), { force: true })]);
  }
  /** The file's bytes from `start` to `end` (inclusive), as a stream. */
  stream(id: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.path(id), { ...range, highWaterMark: 1 << 20 });
  }
  /** The whole file, for the few readers that need it in memory (a picture or text a Bot looks at); `limit` guards
   * against reading a large file by mistake. */
  async read(id: string, limit: number): Promise<Buffer> {
    const handle = await open(this.path(id), "r");
    try {
      const { size } = await handle.stat();
      if (size > limit) throw new FileTooLarge();
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  /** The first bytes of the file, to tell what kind it is. */
  async head(id: string, bytes: number): Promise<Buffer> {
    const handle = await open(this.path(id), "r");
    try {
      const buffer = Buffer.alloc(bytes), { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  async size(id: string): Promise<number | null> {
    try { return (await stat(this.path(id))).size; } catch { return null; }
  }
  /** Removes what no attachment owns: files left in incoming/ by a stop mid-upload, files whose attachment is gone
   * (`known` says which ids still have one), and anything else under the root, such as the readable copies older
   * versions kept in `<id>/<name>` folders. Folders left empty go too. Returns how many files went. */
  async sweep(known: (id: string) => boolean): Promise<number> {
    let removed = 0;
    for (const entry of await entries(this.root)) {
      const path = join(this.root, entry.name);
      if (!entry.isDirectory() || !(SHARD.test(entry.name) || entry.name === INCOMING)) {
        removed += await count(path);
        await rm(path, { force: true, recursive: true });
        continue;
      }
      const files = await entries(path);
      for (const file of files) {
        if (entry.name === INCOMING || !ID.test(file.name) || !file.name.startsWith(entry.name) || !known(file.name)) {
          removed += await count(join(path, file.name));
          await rm(join(path, file.name), { force: true, recursive: true });
        }
      }
      if (entry.name !== INCOMING && !(await entries(path)).length) await rm(path, { force: true, recursive: true });
    }
    return removed;
  }
  path(id: string): string {
    if (!ID.test(id)) throw new Error("Invalid attachment id");
    return attachmentPath(this.root, id);
  }
  private part(id: string): string { return join(this.root, INCOMING, `${id}.part`); }
}

/** How many files a path holds: 1 for a file, its files for a folder. */
async function count(path: string): Promise<number> {
  const inside = await entries(path);
  if (!inside.length) return (await stat(path).catch(() => null))?.isFile() ? 1 : 0;
  let total = 0;
  for (const entry of inside) total += entry.isDirectory() ? await count(join(path, entry.name)) : 1;
  return total;
}
async function entries(path: string): Promise<Dirent[]> {
  try { return await readdir(path, { withFileTypes: true }); } catch { return []; }
}
