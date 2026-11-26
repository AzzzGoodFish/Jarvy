import { COMPUTER_CWD } from "../../infra/env/docker.js";
import { createWorkspaceEnvironment, isWorkspacePath } from "../../infra/env/workspace-fs.js";
import type { EnvironmentRecord, WorkEnvironment } from "../../shared/environment.js";
import { RuntimeFault } from "../../shared/runtime.js";

export interface SandboxEnvironmentOptions {
  /** True when `/workspace` file calls should run directly via the jailed pure-Node workspace engine
   * (container sandbox when Docker is unavailable or the container is not currently running). */
  useWorkspaceFallback: () => boolean;
  /** True when the sandbox runtime itself (Docker/libvirt) is unavailable on this host. */
  runtimeUnavailable: () => boolean;
  /** Fault thrown when `exec` or a non-workspace path cannot use a sandbox runtime. */
  unavailableFault: () => Error;
  /** Runs an operation against the live container or VM sandbox (starting it if needed). */
  runInSandbox: <T>(op: (env: WorkEnvironment) => Promise<T>) => Promise<T>;
  /** Disconnects any open sandbox connection without starting a stopped sandbox. */
  close: () => Promise<void>;
}

/** Builds a Bot's sandbox `WorkEnvironment` with pure-Node `/workspace` fallback (A106):
 * file tools (`read`, `write`, `edit`, attachments) inside `/workspace` work even without Docker or
 * a running container, while `bash` and non-workspace paths route to the sandbox runtime. */
export function createSandboxEnvironment(
  record: EnvironmentRecord,
  workspaceRoot: string,
  options: SandboxEnvironmentOptions,
): WorkEnvironment {
  const localWorkspace = createWorkspaceEnvironment(record.id, workspaceRoot, options.unavailableFault);
  const runFile = async <T>(path: string, localOp: () => Promise<T>, sandboxOp: (env: WorkEnvironment) => Promise<T>): Promise<T> => {
    if (options.useWorkspaceFallback()) {
      if (isWorkspacePath(path)) return localOp();
      if (options.runtimeUnavailable()) {
        throw new RuntimeFault(
          "docker_unavailable",
          `Path '${path}' is outside ${COMPUTER_CWD}. Without a running sandbox, only files inside ${COMPUTER_CWD} are accessible.`,
          503,
        );
      }
    }
    return options.runInSandbox(sandboxOp);
  };

  return {
    id: record.id,
    kind: "computer",
    local: false,
    cwd: COMPUTER_CWD,
    exec: (command, execOptions) => options.runInSandbox(env => env.exec(command, execOptions)),
    readFile: path => runFile(path, () => localWorkspace.readFile(path), env => env.readFile(path)),
    head: (path, bytes) => runFile(path, () => localWorkspace.head(path, bytes), env => env.head(path, bytes)),
    readRange: (path, offset, length) => runFile(path, () => localWorkspace.readRange(path, offset, length), env => env.readRange(path, offset, length)),
    writeFile: (path, content) => runFile(path, () => localWorkspace.writeFile(path, content), env => env.writeFile(path, content)),
    appendFile: (path, content) => runFile(path, () => localWorkspace.appendFile(path, content), env => env.appendFile(path, content)),
    mkdir: path => runFile(path, () => localWorkspace.mkdir(path), env => env.mkdir(path)),
    exists: path => runFile(path, () => localWorkspace.exists(path), env => env.exists(path)),
    fileSize: path => runFile(path, () => localWorkspace.fileSize(path), env => env.fileSize(path)),
    close: () => options.close(),
  };
}
