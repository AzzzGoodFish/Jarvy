import { posix } from "node:path";
import { LocalWorkspace } from "../../infra/files/workspace.js";
import { installSkills } from "../../infra/files/skills.js";
import type { Skill } from "../../shared/skill.js";
import { ChatError, type OutgoingFile } from "../../shared/chat.js";
import { ATTACHMENT_MAX_BYTES } from "../../../contract/chat.js";
import type { WorkEnvironment } from "../../shared/environment.js";
import type { EnvironmentKind } from "../../../contract/environment.js";
import type { Workspace as WorkspacePort } from "./contracts.js";

/** How much of a file moves between the chat and an environment at a time (A66). */
const CHUNK = 4 * 1024 * 1024;

/** The Bot's workspace on the machine running Jarvy (its files, sessions and History live beside it), and where its tools
 * run now (A50). Files move between the chat and the Bot only through here, in the environment it works in. The agent
 * Bot's also holds Jarvy's skills (A55), written again each time it starts. */
export class Workspace implements WorkspacePort {
  private readonly local: LocalWorkspace;
  constructor(cwd: string, private readonly current: () => WorkEnvironment, readonly home: () => { kind: EnvironmentKind; cwd: string },
    private readonly skills: readonly Skill[] = []) { this.local = new LocalWorkspace(cwd); }
  async prepare() { await this.local.prepare(); await installSkills(this.local.cwd, this.skills); }
  /** A file in the temporary directory of the environment the Bot works in, by the path it sees there. */
  async writeTempFile(name: string, content: string, signal?: AbortSignal) {
    const env = this.current();
    if (env.local) return this.local.writeTempFile(name, content, signal);
    const path = `${tempOf(env)}/${name}`;
    await env.writeFile(path, content);
    return path;
  }
  /** Puts a chat file into the Bot's environment: at `path`, or in temp/files/ under its own name (with part of its
   * id when another file has that name). Its contents come in pieces, so a file of gigabytes is never held whole.
   * Returns where it went. */
  async put(name: string, id: string, chunks: AsyncIterable<Uint8Array>, path?: string, signal?: AbortSignal): Promise<string> {
    const env = this.current();
    let target = path ? posix.resolve(env.cwd, path) : `${tempOf(env)}/files/${plain(name)}`;
    if (!path && await env.exists(target)) {
      const dot = plain(name).lastIndexOf("."), stem = dot > 0 ? plain(name).slice(0, dot) : plain(name), extension = dot > 0 ? plain(name).slice(dot) : "";
      target = `${tempOf(env)}/files/${stem}-${id.slice(0, 8)}${extension}`;
    }
    await env.mkdir(posix.dirname(target));
    await env.writeFile(target, new Uint8Array());
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      await env.appendFile(target, chunk);
    }
    return target;
  }
  /** The files a Bot attaches to a message, read from its environment in pieces (paths there, relative to its
   * directory) and handed to the chat's `store`, which writes each aside for the message. On a failure the ones
   * already staged are dropped again. */
  async readOutgoing(items: readonly { path: string; name: string }[], store: StagingStore, signal?: AbortSignal): Promise<OutgoingFile[]> {
    if (items.length > 5) throw new ChatError(400, "Too many attachments");
    const env = this.current(), files: OutgoingFile[] = [];
    try {
      for (const item of items) {
        signal?.throwIfAborted();
        const path = posix.resolve(env.cwd, item.path), size = await env.fileSize(path);
        if (size === null) throw new ChatError(400, `No file at ${path} in your environment`);
        if (!size || size > ATTACHMENT_MAX_BYTES) throw new ChatError(400, "Invalid attachment size or type");
        const staged = await store.stage(pieces(env, path, size, signal), signal);
        files.push({ id: staged.id, name: item.name, mimeType: "application/octet-stream", size: staged.size, sha256: staged.sha256 });
      }
    } catch (error) { await store.discard(files.map(file => file.id)); throw error; }
    return files;
  }
  location() { return { type: "local", cwd: this.local.cwd, tempDir: this.local.tempDir }; }
}

/** Where a message's files are written aside before it is sent (ChatAttachments). */
interface StagingStore {
  stage(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<{ id: string; size: number; sha256: string }>;
  discard(ids: readonly string[]): Promise<void>;
}

/** A file in the environment, `size` bytes as measured before reading, in pieces; a file that changes size while it
 * is read is refused. */
async function* pieces(env: WorkEnvironment, path: string, size: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < size;) {
    signal?.throwIfAborted();
    const chunk = await env.readRange(path, offset, Math.min(CHUNK, size - offset));
    if (!chunk.length) throw new ChatError(409, "Attachment changed while reading");
    offset += chunk.length;
    yield chunk;
  }
  if ((await env.fileSize(path)) !== size) throw new ChatError(409, "Attachment changed while reading");
}

/** A file name safe as one path segment. */
function plain(name: string): string {
  const cleaned = name.replace(/[/\\\0]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

/** Where Jarvy puts files for the Bot in its environment. */
const tempOf = (env: WorkEnvironment) => env.temp ?? `${env.cwd}/temp`;
