import { AsyncLocalStorage } from "node:async_hooks";
import { readFile as readLocal, rm } from "node:fs/promises";
import { basename } from "node:path";
import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkEnvironment } from "../../shared/environment.js";
import type { SecretAccess } from "../../shared/secret.js";
import { StreamMask } from "../../shared/secret-mask.js";
import { IMAGE_SNIFF_BYTES, imageKind } from "./image-kind.js";
import { rewritePlaceholders, secretVariable } from "./secret-placeholders.js";

/** Pi's bash, read, write and edit with their operations on the Bot's current WorkEnvironment (A50), looked up at
 * every call, so a switch takes effect at the next one without a new session. One call stays in the environment it
 * started in, so an edit never reads in one place and writes in another. Registered as custom tools under the
 * built-in names, they replace Pi's local ones; their schemas, output handling and descriptions stay Pi's. A bash
 * command's secret placeholders are filled from its environment, and its output is masked as it streams (A52). */
export function environmentTools(lookup: () => WorkEnvironment, secrets?: SecretAccess): ToolDefinition[] {
  const pinned = new AsyncLocalStorage<Call>();
  const current = () => pinned.getStore()?.env ?? lookup();
  const access = async (path: string) => {
    if (!await current().exists(path)) throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: "ENOENT" });
  };
  const readFile = (path: string) => current().readFile(path), writeFile = (path: string, content: string) => current().writeFile(path, content);
  const cwd = current().cwd;
  const definitions = [
    relocated(createBashToolDefinition(cwd, { operations: {
      exec: async (command, dir, { onData, signal, timeout, env }) => {
        const where = current(), prepared = withSecrets(command, secrets);
        if (prepared.names.length) secrets!.record(prepared.names, { environmentId: where.id, toolCallId: pinned.getStore()?.toolCallId ?? null, detail: command });
        const masker = secrets?.masker(), stream = masker && !masker.empty ? new StreamMask(masker, onData) : null;
        try {
          return await where.exec(prepared.command, { cwd: dir, onData: stream ? chunk => stream.push(chunk) : onData,
            ...(signal ? { signal } : {}), ...(timeout ? { timeout } : {}), ...(env ? { env: defined(env) } : {}), ...(prepared.values ? { secrets: prepared.values } : {}) });
        } finally { stream?.end(); }
      },
    } }) as unknown as ToolDefinition, current),
    // Pictures go to the model as pictures; the kind comes from a file's first bytes, as Pi's local read does.
    createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType: async path => imageKind(await current().head(path, IMAGE_SNIFF_BYTES)) } }),
    createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: path => current().mkdir(path) } }),
    createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } }),
  ];
  return definitions.map(definition => inside(definition as unknown as ToolDefinition, lookup, pinned));
}

/** Pi resolves a tool's paths against the run's working directory (`ctx.cwd`) before its own; they resolve against
 * the directory of the environment the call runs in instead. */
function inside(definition: ToolDefinition, lookup: () => WorkEnvironment, pinned: AsyncLocalStorage<Call>): ToolDefinition {
  const execute = definition.execute.bind(definition) as (...args: unknown[]) => ReturnType<ToolDefinition["execute"]>;
  return { ...definition, execute: ((...args: unknown[]) => {
    const env = lookup(), ctx = args[4];
    if (ctx && typeof ctx === "object") args[4] = new Proxy(ctx, { get: (target, key) => key === "cwd" ? env.cwd : Reflect.get(target, key, target) });
    return pinned.run({ env, toolCallId: typeof args[0] === "string" ? args[0] : null }, () => execute(...args));
  }) as ToolDefinition["execute"] };
}
type Call = { env: WorkEnvironment; toolCallId: string | null };

/** The command to run, with placeholders turned into variables, and the values those variables take. A placeholder
 * the Bot may not use fails the call before anything runs. */
function withSecrets(command: string, secrets: SecretAccess | undefined): { command: string; names: string[]; values?: Record<string, string> } {
  const rewritten = rewritePlaceholders(command);
  if ("error" in rewritten) throw new Error(rewritten.error);
  if (!rewritten.names.length) return { command, names: [] };
  const resolved = secrets?.resolve(rewritten.names) ?? { refused: rewritten.names };
  if ("refused" in resolved) throw new Error(`You have no secret named ${resolved.refused.join(", ")}. secrets.list in the chat gateway shows the ones you may use. If you need another, use secrets.request; never ask for a value in the chat.`);
  return { command: rewritten.command, names: rewritten.names, values: Object.fromEntries(Object.entries(resolved.values).map(([name, value]) => [secretVariable(name), value])) };
}

type Output = { content: { type: string; text?: string }[]; details?: { fullOutputPath?: unknown }; structuredContent?: Record<string, unknown> };

/** Pi keeps the whole of a long command output in a file on this machine and names it in the result. A Bot working
 * elsewhere gets the file in its environment's temp directory instead, under the path it can read there. */
function relocated(definition: ToolDefinition, current: () => WorkEnvironment): ToolDefinition {
  const execute = definition.execute.bind(definition) as (...args: unknown[]) => Promise<Output>;
  return { ...definition, execute: (async (...args: unknown[]) => {
    const env = current();
    if (env.local) return execute(...args);
    try {
      const result = await execute(...args), path = result.details?.fullOutputPath;
      if (typeof path !== "string") return result;
      const target = await moveOut(path, env), swap = (text?: string) => text?.replaceAll(path, target);
      return { ...result, content: result.content.map(part => part.type === "text" ? { ...part, text: swap(part.text) } : part),
        details: { ...result.details, fullOutputPath: target },
        ...(result.structuredContent?.full_output_path ? { structuredContent: { ...result.structuredContent, full_output_path: target } } : {}) };
    } catch (error) {
      // An aborted or timed-out command fails with its output, which may name the file too.
      const path = error instanceof Error ? /Full output: (\S+?)\]/.exec(error.message)?.[1] : undefined;
      if (!path) throw error;
      throw new Error((error as Error).message.replaceAll(path, await moveOut(path, env)));
    }
  }) as unknown as ToolDefinition["execute"] };
}
async function moveOut(path: string, env: WorkEnvironment): Promise<string> {
  const target = `${env.temp ?? `${env.cwd}/temp`}/${basename(path)}`;
  await env.writeFile(target, await readLocal(path));
  await rm(path, { force: true });
  return target;
}

function defined(vars: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

