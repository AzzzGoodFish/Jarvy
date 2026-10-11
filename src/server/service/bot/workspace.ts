import { LocalWorkspace } from "../../infra/files/workspace.js";
import type { Workspace as WorkspacePort } from "./contracts.js";

export class Workspace implements WorkspacePort {
  private readonly local: LocalWorkspace;
  constructor(cwd: string) { this.local = new LocalWorkspace(cwd); }
  prepare() { return this.local.prepare(); }
  writeTempFile(name: string, content: string, signal?: AbortSignal) { return this.local.writeTempFile(name, content, signal); }
  location() { return { type: "local", cwd: this.local.cwd, tempDir: this.local.tempDir }; }
}
