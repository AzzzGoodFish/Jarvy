import { AsyncLocalStorage } from "node:async_hooks";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkEnvironment } from "../../shared/environment.js";
import type { CommandJobs } from "../../shared/jobs.js";
import type { SecretAccess } from "../../shared/secret.js";
import { bashTools, type BashCallContext } from "./bash-tools.js";
import { IMAGE_SNIFF_BYTES, imageKind } from "./image-kind.js";

/** Pi's read, write and edit plus Jarvy's background-capable bash and bash_job on the Bot's current WorkEnvironment
 * (A50, A98), looked up at every call so a switch takes effect at the next one without a new session. One call stays
 * in the environment it started in, so an edit never reads in one place and writes in another. A bash command's secret
 * placeholders are filled from its environment, and its output is masked as it streams (A52). */
export function environmentTools(lookup: () => { env: WorkEnvironment; name: string }, jobs: CommandJobs, secrets?: SecretAccess): ToolDefinition[] {
  const pinned = new AsyncLocalStorage<BashCallContext>();
  const currentCall = (): BashCallContext => pinned.getStore() ?? { ...lookup(), toolCallId: null };
  const current = () => currentCall().env;
  const access = async (path: string) => {
    if (!await current().exists(path)) throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: "ENOENT" });
  };
  const readFile = (path: string) => current().readFile(path), writeFile = (path: string, content: string) => current().writeFile(path, content);
  const cwd = current().cwd;
  const definitions: ToolDefinition[] = [
    ...bashTools(currentCall, jobs, secrets),
    // Pictures go to the model as pictures; the kind comes from a file's first bytes, as Pi's local read does.
    createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType: async path => imageKind(await current().head(path, IMAGE_SNIFF_BYTES)) } }) as unknown as ToolDefinition,
    createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: path => current().mkdir(path) } }) as unknown as ToolDefinition,
    createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } }) as unknown as ToolDefinition,
  ];
  return definitions.map(definition => inside(definition, lookup, pinned));
}

/** Pi resolves a tool's paths against the run's working directory (`ctx.cwd`) before its own; they resolve against
 * the directory of the environment the call runs in instead. */
function inside(definition: ToolDefinition, lookup: () => { env: WorkEnvironment; name: string }, pinned: AsyncLocalStorage<BashCallContext>): ToolDefinition {
  const execute = definition.execute.bind(definition) as (...args: unknown[]) => ReturnType<ToolDefinition["execute"]>;
  return { ...definition, execute: ((...args: unknown[]) => {
    const { env, name } = lookup(), ctx = args[4], params = args[1] as { path?: unknown } | undefined;
    if (ctx && typeof ctx === "object") args[4] = new Proxy(ctx, { get: (target, key) => key === "cwd" ? env.cwd : Reflect.get(target, key, target) });
    if (env.normalize && params && typeof params.path === "string") args[1] = { ...params, path: env.normalize(params.path) };
    return pinned.run({ env, name, toolCallId: typeof args[0] === "string" ? args[0] : null }, () => execute(...args));
  }) as ToolDefinition["execute"] };
}
