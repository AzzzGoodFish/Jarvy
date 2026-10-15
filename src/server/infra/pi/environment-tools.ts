import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkEnvironment } from "../../shared/environment.js";
import { IMAGE_SNIFF_BYTES, imageKind } from "./image-kind.js";

/** Pi's bash, read, write and edit with their operations on the Bot's current WorkEnvironment (A50), looked up at
 * every call, so a switch takes effect at the next one without a new session. Registered as custom tools under the
 * built-in names, they replace Pi's local ones; their schemas, output handling and descriptions stay Pi's. */
export function environmentTools(current: () => WorkEnvironment): ToolDefinition[] {
  const access = async (path: string) => {
    if (!await current().exists(path)) throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: "ENOENT" });
  };
  const readFile = (path: string) => current().readFile(path), writeFile = (path: string, content: string) => current().writeFile(path, content);
  const cwd = current().cwd;
  const definitions = [
    createBashToolDefinition(cwd, { operations: {
      exec: (command, dir, { onData, signal, timeout, env }) => current().exec(command, { cwd: dir, onData,
        ...(signal ? { signal } : {}), ...(timeout ? { timeout } : {}), ...(env ? { env: defined(env) } : {}) }),
    } }),
    // Pictures go to the model as pictures; the kind comes from a file's first bytes, as Pi's local read does.
    createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType: async path => imageKind(await current().head(path, IMAGE_SNIFF_BYTES)) } }),
    createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: path => current().mkdir(path) } }),
    createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } }),
  ];
  return definitions.map(definition => inside(definition as unknown as ToolDefinition, current));
}

/** Pi resolves a tool's paths against the run's working directory (`ctx.cwd`) before its own; they resolve against
 * the current environment's directory instead. */
function inside(definition: ToolDefinition, current: () => WorkEnvironment): ToolDefinition {
  const execute = definition.execute.bind(definition) as (...args: unknown[]) => ReturnType<ToolDefinition["execute"]>;
  return { ...definition, execute: ((...args: unknown[]) => {
    const ctx = args[4];
    if (ctx && typeof ctx === "object") args[4] = new Proxy(ctx, { get: (target, key) => key === "cwd" ? current().cwd : Reflect.get(target, key, target) });
    return execute(...args);
  }) as ToolDefinition["execute"] };
}

function defined(vars: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

