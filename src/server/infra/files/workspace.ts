import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class LocalWorkspace {
  constructor(readonly cwd: string) {}
  get tempDir() { return join(this.cwd, "temp"); }
  async prepare() { await mkdir(this.tempDir, { recursive: true, mode: 0o700 }); }
  async writeTempFile(name: string, content: string, signal?: AbortSignal): Promise<string> {
    await this.prepare();
    const path = join(this.tempDir, name);
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600, signal });
    return path;
  }
}

