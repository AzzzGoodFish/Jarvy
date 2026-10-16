import { posix } from "node:path";
import { LocalWorkspace } from "../../infra/files/workspace.js";
import { ChatError, type OutgoingFile } from "../../shared/chat.js";
import type { EnvironmentKind, WorkEnvironment } from "../../shared/environment.js";
import type { Workspace as WorkspacePort } from "./contracts.js";

const MAX_FILE = 10 * 1024 * 1024;

/** The Bot's workspace on the owner's computer (its files, sessions and History live beside it), and where its tools
 * run now (A50). Files move between the chat and the Bot only through here, in the environment it works in. */
export class Workspace implements WorkspacePort {
  private readonly local: LocalWorkspace;
  constructor(cwd: string, private readonly current: () => WorkEnvironment, readonly home: () => { kind: EnvironmentKind; cwd: string }) { this.local = new LocalWorkspace(cwd); }
  prepare() { return this.local.prepare(); }
  /** A file in the temporary directory of the environment the Bot works in, by the path it sees there. */
  async writeTempFile(name: string, content: string, signal?: AbortSignal) {
    const env = this.current();
    if (env.kind === "host") return this.local.writeTempFile(name, content, signal);
    const path = `${env.cwd}/temp/${name}`;
    await env.writeFile(path, content);
    return path;
  }
  /** Puts a chat file into the Bot's environment: at `path`, or in temp/files/ under its own name (with part of its
   * id when another file has that name). Returns where it went. */
  async put(name: string, id: string, data: Uint8Array, path?: string): Promise<string> {
    const env = this.current();
    let target = path ? posix.resolve(env.cwd, path) : `${env.cwd}/temp/files/${plain(name)}`;
    if (!path && await env.exists(target)) {
      const dot = plain(name).lastIndexOf("."), stem = dot > 0 ? plain(name).slice(0, dot) : plain(name), extension = dot > 0 ? plain(name).slice(dot) : "";
      target = `${env.cwd}/temp/files/${stem}-${id.slice(0, 8)}${extension}`;
    }
    await env.mkdir(posix.dirname(target));
    await env.writeFile(target, data);
    return target;
  }
  /** The files a Bot attaches to a message, read from its environment: paths there, relative to its directory. */
  async readOutgoing(items: readonly { path: string; name: string }[], signal?: AbortSignal): Promise<OutgoingFile[]> {
    if (items.length > 5) throw new ChatError(400, "Too many attachments");
    const env = this.current(), files: OutgoingFile[] = [];
    for (const item of items) {
      signal?.throwIfAborted();
      const path = posix.resolve(env.cwd, item.path), size = await env.fileSize(path);
      if (size === null) throw new ChatError(400, `No file at ${path} in your environment`);
      if (!size || size > MAX_FILE) throw new ChatError(400, "Invalid attachment size or type");
      const data = await env.readFile(path);
      if (data.length !== size) throw new ChatError(409, "Attachment changed while reading");
      files.push({ name: item.name, mimeType: "application/octet-stream", data });
    }
    return files;
  }
  location() { return { type: "local", cwd: this.local.cwd, tempDir: this.local.tempDir }; }
}

/** A file name safe as one path segment. */
function plain(name: string): string {
  const cleaned = name.replace(/[/\\\0]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}
