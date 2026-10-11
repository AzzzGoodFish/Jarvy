import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ChatError, type OutgoingFile } from "../../shared/chat.js";

const MAX_FILE = 10 * 1024 * 1024;
export class AttachmentFiles {
  constructor(private readonly dataDir: string) {}
  async materialize(file: { id: string; name: string; data: Buffer }, signal?: AbortSignal) {
    const dir = join(this.dataDir, "attachments", file.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await realpath(dir) !== resolve(dir)) throw new ChatError(400, "Invalid attachment directory");
    const path = join(dir, file.name), temporary = join(dir, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(file.data, { signal }); }
      finally { await handle.close(); }
      signal?.throwIfAborted(); await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return { path, name: file.name };
  }
  async readOutgoing(workspace: string, items: readonly { path: string; name: string }[], signal?: AbortSignal): Promise<OutgoingFile[]> {
    if (items.length > 5) throw new ChatError(400, "Too many attachments");
    const result: OutgoingFile[] = [];
    for (const item of items) {
      signal?.throwIfAborted();
      const path = await realpath(resolve(workspace, item.path));
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !stat.size || stat.size > MAX_FILE) throw new ChatError(400, "Invalid attachment size or type");
        const data = Buffer.alloc(Math.min(MAX_FILE + 1, stat.size + 1));
        let bytes = 0;
        while (bytes < data.length) {
          signal?.throwIfAborted();
          const read = await handle.read(data, bytes, data.length - bytes, bytes);
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
        }
        if (bytes !== stat.size) throw new ChatError(409, "Attachment changed while reading");
        result.push({ name: item.name, mimeType: "application/octet-stream", data: data.subarray(0, bytes) });
      } finally { await handle.close(); }
    }
    return result;
  }
}
