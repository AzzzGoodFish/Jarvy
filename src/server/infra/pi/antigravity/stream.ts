import { calculateCost, clampThinkingLevel, createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model,
  type SimpleStreamOptions, type TextContent, type ThinkingContent, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { isThinkingPart, mapStopReasonString, retainThoughtSignature } from "@earendil-works/pi-ai/api/google-shared";
import { headersToRecord, providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { apiHeaders, ENDPOINTS, errorMessage, isRecord } from "./client.js";
import { attemptSession } from "./envelope.js";
import { catalogFor, runtimeModel } from "./models.js";
import { parseApiKey } from "./oauth.js";
import { buildRequest } from "./request.js";

/** One answer from Antigravity (A91), ported from pi-antigravity (MIT) and Pi's former Cloud Code Assist provider:
 * the request to each endpoint in turn, its server-sent events as Pi's, and an empty answer asked again. */
const EMPTY_RETRIES = 2;
/** What makes the next endpoint worth trying. A 429 only when it is a short throttle: a quota or a model that isn't
 * there is the same everywhere. */
const NEXT_ENDPOINT = new Set([403, 404, 429, 500, 502, 503, 504]);
let callCount = 0;

export function streamAntigravity(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = blank(model);
    try {
      const { token, projectId } = parseApiKey(options.apiKey);
      const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
      const catalog = await catalogFor(token, projectId);
      const runtime = runtimeModel(catalog, model.id, level);
      const headers = { ...apiHeaders(token), Accept: "text/event-stream", ...providerHeadersToRecord(model.headers, options.headers) };
      const fetcher = options.fetch ?? fetch;
      for (let attempt = 0; ; attempt++) {
        let body: unknown = buildRequest(model, context, projectId, runtime, catalog,
          { level, maxTokens: options.maxTokens, temperature: options.temperature, toolChoice: options.toolChoice, sessionId: attemptSession(options.sessionId, context) });
        body = (await options.onPayload?.(body, model)) ?? body;
        const response = await send(fetcher, JSON.stringify(body), headers, options, model);
        Object.assign(output, blank(model));
        if (await read(response, stream, output, model, options.signal)) break;
        if (attempt >= EMPTY_RETRIES) throw new Error("Antigravity returned an empty answer.");
        await wait(500 * 2 ** attempt, options.signal);
      }
      if (options.signal?.aborted) throw new Error("Request was aborted");
      if (output.stopReason === "pending") throw new Error("Antigravity's answer ended without a finish reason.");
      if (output.stopReason === "error" || output.stopReason === "aborted")
        throw new Error(output.rawStopReason ? `Antigravity stopped with ${output.rawStopReason}` : "Antigravity stopped with an error.");
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    }
    stream.end();
  })();
  return stream;
}

/** The first endpoint that answers; a network failure or one of NEXT_ENDPOINT moves on, the last failure is said. */
async function send(fetcher: typeof fetch, body: string, headers: Record<string, string>, options: SimpleStreamOptions, model: Model<Api>): Promise<Response> {
  let failure: Error | undefined;
  for (const endpoint of ENDPOINTS) {
    let response: Response;
    try {
      response = await fetcher(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, { method: "POST", headers, body, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failure = error instanceof Error && error.message === "fetch failed" && error.cause instanceof Error ? new Error(`Network error: ${error.cause.message}`)
        : error instanceof Error ? error : new Error(String(error));
      continue;
    }
    await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
    if (response.ok) return response;
    const text = await response.text();
    failure = new Error(describe(response.status, text));
    if (!NEXT_ENDPOINT.has(response.status) || (response.status === 429 && !/rate.?limit|too many requests/i.test(text))) break;
  }
  throw failure ?? new Error("Antigravity could not be reached.");
}

/** The backend's words with the status. A quota that has run out leaves the digits 429 out, so Pi doesn't retry what
 * won't work until it resets. */
export function describe(status: number, body: string): string {
  const message = errorMessage(body);
  if (status === 429) {
    const reset = /Resets? in ([^.\n]+)/i.exec(message)?.[1]?.trim();
    if (reset || (!/rate.?limit/i.test(message) && /quota exceeded|exceeded your|limit reached|reached your|daily limit|quota reached/i.test(message))) {
      const rest = message.replace(/\s*Resets? in [^.\n]+\.?/i, "").trim();
      return `Antigravity quota reached${reset ? `; it resets in ${reset}` : ""}.${rest ? ` ${rest}` : ""}`;
    }
  }
  return `Antigravity error (${status}): ${message}`;
}

function blank(model: Model<Api>): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "pending", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

interface Chunk {
  error?: { code?: unknown; message?: unknown };
  candidates?: { content?: { parts?: Record<string, unknown>[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number };
  responseId?: string;
}

/** The answer's events, as Pi's Gemini providers emit them. True when it had any content. */
async function read(response: Response, stream: AssistantMessageEventStream, output: AssistantMessage, model: Model<Api>, signal?: AbortSignal): Promise<boolean> {
  if (!response.body) throw new Error("Antigravity's answer has no body.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  let buffer = "", started = false, content = false, block: TextContent | ThinkingContent | null = null;
  const index = () => output.content.length - 1;
  const start = () => { if (!started) { started = true; stream.push({ type: "start", partial: output }); } };
  const close = () => {
    if (block?.type === "text") stream.push({ type: "text_end", contentIndex: index(), content: block.text, partial: output });
    else if (block) stream.push({ type: "thinking_end", contentIndex: index(), content: block.thinking, partial: output });
    block = null;
  };
  const chunk = (data: Chunk) => {
    if (data.error) throw new Error(describe(typeof data.error.code === "number" ? data.error.code : 0, JSON.stringify({ error: data.error })));
    output.responseId ||= data.responseId;
    const candidate = data.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === "string") {
        content = true;
        const thinking = isThinkingPart(part);
        if (!block || (thinking ? block.type !== "thinking" : block.type !== "text")) {
          close();
          block = thinking ? { type: "thinking", thinking: "", thinkingSignature: undefined } : { type: "text", text: "" };
          output.content.push(block);
          start();
          stream.push({ type: thinking ? "thinking_start" : "text_start", contentIndex: index(), partial: output });
        }
        const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
        if (block.type === "thinking") {
          block.thinking += part.text;
          block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, signature);
          stream.push({ type: "thinking_delta", contentIndex: index(), delta: part.text, partial: output });
        } else {
          block.text += part.text;
          block.textSignature = retainThoughtSignature(block.textSignature, signature);
          stream.push({ type: "text_delta", contentIndex: index(), delta: part.text, partial: output });
        }
      }
      if (isRecord(part.functionCall)) {
        content = true;
        close();
        const call = part.functionCall, name = typeof call.name === "string" ? call.name : "";
        const given = typeof call.id === "string" ? call.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : "";
        const id = given && !output.content.some(each => each.type === "toolCall" && each.id === given) ? given : `${name || "tool"}_${Date.now()}_${++callCount}`;
        const toolCall: ToolCall = { type: "toolCall", id, name, arguments: (isRecord(call.args) ? call.args : {}) as ToolCall["arguments"],
          ...(typeof part.thoughtSignature === "string" ? { thoughtSignature: part.thoughtSignature } : {}) };
        output.content.push(toolCall);
        start();
        stream.push({ type: "toolcall_start", contentIndex: index(), partial: output });
        stream.push({ type: "toolcall_delta", contentIndex: index(), delta: JSON.stringify(toolCall.arguments), partial: output });
        stream.push({ type: "toolcall_end", contentIndex: index(), toolCall, partial: output });
      }
    }
    if (candidate?.finishReason) {
      output.rawStopReason = candidate.finishReason;
      output.stopReason = mapStopReasonString(candidate.finishReason);
      if (output.stopReason === "stop" && output.content.some(each => each.type === "toolCall")) output.stopReason = "toolUse";
    }
    const usage = data.usageMetadata;
    if (usage) {
      const cached = usage.cachedContentTokenCount ?? 0, thoughts = usage.thoughtsTokenCount ?? 0;
      output.usage = { input: (usage.promptTokenCount ?? 0) - cached, output: (usage.candidatesTokenCount ?? 0) + thoughts, cacheRead: cached, cacheWrite: 0,
        reasoning: thoughts, totalTokens: usage.totalTokenCount ?? 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      calculateCost(model, output.usage);
    }
  };
  const line = (raw: string) => {
    const text = raw.replace(/\r$/, "");
    if (!text.startsWith("data:")) {
      // An error can come as a plain JSON body inside the stream.
      if (text.trim().startsWith("{")) try { const parsed = JSON.parse(text) as Chunk; if (parsed.error) chunk(parsed); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      return;
    }
    const json = text.slice(5).trim();
    if (!json || json === "[DONE]") return;
    let parsed: { response?: Chunk } & Chunk;
    try { parsed = JSON.parse(json); } catch { return; }
    chunk(parsed.error ? parsed : parsed.response ?? parsed);
  };
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const each of lines) line(each);
    }
    buffer += decoder.decode();
    if (buffer) line(buffer);
  } finally { signal?.removeEventListener("abort", cancel); }
  close();
  return content;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Request was aborted"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(new Error("Request was aborted")); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
