import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { EnvironmentKind, ExecOptions, WorkEnvironment } from "../../shared/environment.js";

/** A WorkEnvironment over one of Pi Durable's execution environments: the host's `NodeExecutionEnv` or pi-env's
 * `RemoteExecutionEnv`, which behaves like it on the far side. `passEnv` says whether the command gets the environment
 * Pi built for it (only on this machine). */
export function overDurable(id: string, kind: EnvironmentKind, env: ExecutionEnv, options: { passEnv: boolean; close?: () => void | Promise<void> }): WorkEnvironment {
  let closed = false;
  return {
    id, kind, cwd: env.cwd,
    async exec(command: string, exec: ExecOptions) {
      const result = await env.exec(command, {
        cwd: exec.cwd,
        ...(options.passEnv && exec.env ? { env: exec.env, inheritEnv: false } : { inheritEnv: true }),
        ...(exec.timeout ? { timeout: exec.timeout } : {}),
        onOutput: text => exec.onData(Buffer.from(text)),
      }, context(exec.signal));
      if (result.ok) return { exitCode: result.value.exitCode };
      // Pi's bash tool tells these two apart by their message.
      if (result.error.code === "aborted") throw new Error("aborted");
      if (result.error.code === "timeout") throw new Error(`timeout:${exec.timeout}`);
      throw fault(result.error);
    },
    async readFile(path) { return Buffer.from(unwrap(await env.readBinaryFile(path, BACKGROUND_CONTEXT))); },
    async head(path, bytes) {
      const reader = unwrap(await env.openBinaryReader(path, undefined, BACKGROUND_CONTEXT));
      try { return Buffer.from(unwrap(await reader.read(0, bytes, BACKGROUND_CONTEXT))); }
      finally { await reader.close(BACKGROUND_CONTEXT); }
    },
    async writeFile(path, content) { unwrap(await env.writeFile(path, content, BACKGROUND_CONTEXT)); },
    async mkdir(path) { unwrap(await env.createDir(path, { recursive: true }, BACKGROUND_CONTEXT)); },
    async exists(path) { return unwrap(await env.exists(path, BACKGROUND_CONTEXT)); },
    async fileSize(path) {
      const real = await env.canonicalPath(path, BACKGROUND_CONTEXT);
      if (!real.ok) { if (real.error.code === "not_found") return null; throw fault(real.error); }
      const info = unwrap(await env.fileInfo(real.value, BACKGROUND_CONTEXT));
      return info.kind === "file" ? info.size : null;
    },
    async close() { if (closed) return; closed = true; await options.close?.(); },
  };
}

const context = (signal?: AbortSignal): Context => signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error & { code?: string } }): T {
  if (result.ok) return result.value;
  throw fault(result.error);
}
function fault(error: Error & { code?: string }): Error {
  return Object.assign(new Error(error.message), { code: error.code });
}
