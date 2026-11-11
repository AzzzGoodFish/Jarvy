import { getCurrentTools, getInitialSystemMessage, getSystemMessageText, type Api, type Model, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/google-shared";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import { isRecord } from "./client.js";
import { thinkingConfig, type Catalog } from "./models.js";
import { envelope } from "./envelope.js";

/** The body of one `streamGenerateContent` call (A91). Messages become Gemini's contents through Pi's own Gemini
 * code; the rest — the fixes Cloud Code Assist needs, the tool schemas and the envelope — is ported from pi-antigravity
 * (MIT). */
type Part = Record<string, unknown> & { text?: string; functionCall?: Record<string, unknown>; functionResponse?: Record<string, unknown>; thoughtSignature?: string };
interface Content { role: string; parts: Part[] }

const DEFAULT_SYSTEM = ["You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. "
  + "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.",
'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.'];
const CONTINUE = "Continue the active task using the available instructions and context.";

export interface RequestOptions { level?: string; maxTokens?: number; temperature?: number; sessionId?: string; toolChoice?: string }

export function buildRequest(model: Model<Api>, context: TranscriptContext, project: string, runtime: string, catalog: Catalog, options: RequestOptions): Record<string, unknown> {
  const custom = /^(claude|gpt-oss)-/.test(model.id) || /^(claude|gpt-oss)-/.test(runtime);
  const contents = fixTurns(convertMessages(model as unknown as Model<"google-generative-ai">, context) as unknown as Content[], runtime, custom);
  const system = getInitialSystemMessage(context.messages);
  const prompt = system ? getSystemMessageText(system) : "";
  const request: Record<string, unknown> = { contents,
    systemInstruction: { role: "user", parts: prompt ? [{ text: sanitizeSurrogates(prompt) }] : DEFAULT_SYSTEM.map(text => ({ text })) } };
  const most = catalog.limits[runtime] ?? model.maxTokens;
  const config: Record<string, unknown> = { maxOutputTokens: Math.min(options.maxTokens ?? model.maxTokens, most) };
  if (options.temperature !== undefined) config.temperature = options.temperature;
  const thinking = thinkingConfig(runtime, options.level);
  if (thinking) config.thinkingConfig = thinking;
  request.generationConfig = config;
  const tools = getCurrentTools(context.messages);
  if (tools.length) request.tools = [{ functionDeclarations: tools.map(tool => declaration(tool, custom)) }];
  if (options.toolChoice && options.toolChoice !== "auto")
    request.toolConfig = { functionCallingConfig: { mode: options.toolChoice === "none" ? "NONE" : "ANY" } };
  const wire = envelope(runtime, catalog.enums[runtime], contents.length, context, options.sessionId);
  request.sessionId = wire.sessionId;
  request.labels = wire.labels;
  return { project, model: runtime, request, requestType: "agent", userAgent: "antigravity", requestId: wire.requestId };
}

/** What Cloud Code Assist needs of the turns beyond Gemini's own rules. */
export function fixTurns(converted: Content[], runtime: string, custom: boolean): Content[] {
  let contents = writeUnsigned(converted, runtime);
  // Tool call IDs only for Claude and GPT-OSS, as the extension sends them.
  if (!custom) for (const turn of contents) for (const part of turn.parts) {
    if (part.functionCall) delete part.functionCall.id;
    if (part.functionResponse) delete part.functionResponse.id;
  }
  contents = merge(contents);
  // A turn of tool calls must follow one of the user's (or of tool results); compacted history can lose that.
  for (let index = 0; index < contents.length; index++)
    if (contents[index]!.role === "model" && contents[index]!.parts.some(part => part.functionCall) && contents[index - 1]?.role !== "user")
      contents.splice(index++, 0, { role: "user", parts: [{ text: CONTINUE }] });
  // A request needs some words of the user's, a run of tool results included.
  if (contents.length && !contents.some(turn => turn.role === "user" && turn.parts.some(part => typeof part.text === "string" && part.text.trim()))) {
    const first = contents.find(turn => turn.role === "user");
    if (first) first.parts.push({ text: CONTINUE }); else contents.unshift({ role: "user", parts: [{ text: CONTINUE }] });
  }
  const last = contents.at(-1);
  if (last?.role === "model") {
    if (last.parts.some(part => part.functionCall)) throw new Error("The last tool call has no result yet.");
    contents.push({ role: "user", parts: [{ text: CONTINUE }] });
  }
  return contents;
}

/** Gemini 3 rejects a turn of tool calls without a thought signature, as one from another model has; such calls and
 * their results are written as text. */
function writeUnsigned(contents: Content[], runtime: string): Content[] {
  const major = /^gemini-(\d+)/.exec(runtime)?.[1];
  if (!runtime.startsWith("gemini-") || (major !== undefined && Number(major) < 3)) return contents;
  const written = new Map<string, string>();
  const key = (call: Record<string, unknown>) => typeof call.id === "string" && call.id ? call.id : `name:${String(call.name)}`;
  for (const turn of contents) {
    if (turn.role === "model") {
      const calls = turn.parts.filter(part => part.functionCall);
      // Pi's conversion keeps only valid signatures, and only from this same model.
      if (!calls.length || calls[0]!.thoughtSignature) continue;
      for (const part of calls) {
        const args = JSON.stringify(part.functionCall!.args ?? {});
        written.set(key(part.functionCall!), `\`${String(part.functionCall!.name)}\`${args === "{}" ? "" : ` (${args})`}`);
      }
      turn.parts = turn.parts.filter(part => !part.functionCall);
    } else turn.parts = turn.parts.flatMap(part => {
      const result = part.functionResponse, label = result && written.get(key(result));
      if (!result || !label) return [part];
      const response = isRecord(result.response) ? result.response : {};
      const output = String(response.output ?? response.error ?? "");
      return [{ text: sanitizeSurrogates(`[Observation from ${label}:\n${output}]`) }, ...(Array.isArray(result.parts) ? result.parts as Part[] : [])];
    });
  }
  return contents;
}

function merge(contents: Content[]): Content[] {
  const merged: Content[] = [];
  for (const turn of contents) {
    if (!turn.parts.length) continue;
    const last = merged.at(-1);
    if (last?.role === turn.role) last.parts.push(...turn.parts); else merged.push({ role: turn.role, parts: [...turn.parts] });
  }
  return merged;
}

/** Gemini takes JSON Schema; Claude and GPT-OSS go through a bridge that takes the older `parameters` field and only
 * these keywords (anything else is a 400). Pi still checks a call's arguments against the full schema. */
const BRIDGE = new Set(["type", "description", "properties", "required", "items", "enum"]);
const META = new Set(["$schema", "$id", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions"]);
function declaration(tool: Tool, custom: boolean): Record<string, unknown> {
  const given = isRecord(tool.parameters) ? tool.parameters : {};
  const root = given.type ? given : { ...given, type: "object", properties: given.properties ?? {} };
  return { name: tool.name, description: tool.description, ...(custom ? { parameters: bridge(root) } : { parametersJsonSchema: withoutMeta(root) }) };
}
function bridge(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(bridge);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!BRIDGE.has(key)) continue;
    // A union type such as ["string", "null"] becomes its first type that isn't null.
    if (key === "type") { const type = Array.isArray(value) ? value.find(each => typeof each === "string" && each !== "null") : value; if (typeof type === "string") out.type = type; }
    else if (key === "properties" && isRecord(value)) out.properties = Object.fromEntries(Object.entries(value).map(([name, each]) => [name, bridge(each)]));
    else if (key === "enum") { if (Array.isArray(value) && value.every(each => typeof each === "string")) out.enum = value; }
    else out[key] = bridge(value);
  }
  return out;
}
function withoutMeta(schema: unknown, inProperties = false): unknown {
  if (Array.isArray(schema)) return schema.map(each => withoutMeta(each));
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => inProperties || !META.has(key))
    .map(([key, value]) => [key, withoutMeta(value, !inProperties && key === "properties")]));
}
