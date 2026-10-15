import { LocalWorkspace } from "../../infra/files/workspace.js";
import type { EnvironmentKind, WorkEnvironment } from "../../shared/environment.js";
import type { Workspace as WorkspacePort } from "./contracts.js";

/** The Bot's workspace on the owner's computer (its files, sessions and History live beside it), and where its tools
 * run now (A50). */
export class Workspace implements WorkspacePort {
  private readonly local: LocalWorkspace;
  constructor(cwd: string, private readonly current: () => WorkEnvironment) { this.local = new LocalWorkspace(cwd); }
  prepare() { return this.local.prepare(); }
  /** A file in the temporary directory of the environment the Bot works in, by the path it sees there. */
  async writeTempFile(name: string, content: string, signal?: AbortSignal) {
    const env = this.current();
    if (env.kind === "host") return this.local.writeTempFile(name, content, signal);
    const path = `${env.cwd}/temp/${name}`;
    await env.writeFile(path, content);
    return path;
  }
  location() { return { type: "local", cwd: this.local.cwd, tempDir: this.local.tempDir }; }
  environment(): { kind: EnvironmentKind; cwd: string } { const env = this.current(); return { kind: env.kind, cwd: env.cwd }; }
}
