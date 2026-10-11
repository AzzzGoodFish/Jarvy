import { RuntimeFault } from "../../shared/runtime.js";
import type { ConfiguredModel } from "../../shared/models.js";

/** Listing endpoints are protocol-specific; this is not a model inference test. */
export async function discoverModels(input: { api: string; baseUrl: string; key: string }, signal: AbortSignal): Promise<ConfiguredModel[]> {
  const api = String(input.api ?? "openai-completions");
  if (!["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(api)) throw new RuntimeFault("discovery_protocol", "此协议暂不支持获取模型列表。", 400);
  if (typeof input.baseUrl !== "string") throw new RuntimeFault("discovery_url", "请填写 API URL。", 400);
  const url = new URL(input.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new RuntimeFault("discovery_url", "API URL 无效。", 400);
  const key = input.key;
  let path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/models")) {
    if (!/\/v\d+(?:beta\d*)?$/.test(path)) {
      if (api === "anthropic-messages") path += "/v1";
      if (api === "google-generative-ai") path += "/v1beta";
    }
    url.pathname = `${path}/models`;
  }
  const headers = new Headers({ Accept: "application/json" });
  if (api === "anthropic-messages") { headers.set("x-api-key", key); headers.set("anthropic-version", "2023-06-01"); }
  else if (api === "google-generative-ai") headers.set("x-goog-api-key", key);
  else headers.set("Authorization", `Bearer ${key}`);
  const models = new Map<string, ConfiguredModel>();
  let more = true;
  while (more) {
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw new RuntimeFault("discovery_http", `获取模型失败：HTTP ${response.status}。`, 502);
    const body = await response.json() as Record<string, unknown>;
    const items = api === "google-generative-ai" ? body.models : body.data;
    if (!Array.isArray(items)) throw new RuntimeFault("discovery_format", "返回内容不是此协议的模型列表。", 502);
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const id = String(item.id ?? item.name ?? "").replace(/^models\//, "");
      if (!id) continue;
      const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
      models.set(id, { id, name: String(item.display_name ?? item.displayName ?? item.name ?? id),
        reasoning: item.reasoning === true, input: Array.isArray(item.input) && item.input.includes("image") ? ["text", "image"] : ["text"],
        contextWindow: positive(item.context_window ?? item.context_length ?? item.inputTokenLimit),
        maxTokens: positive(item.max_output_tokens ?? item.max_tokens ?? item.outputTokenLimit), thinkingFormat: "", thinkingLevelMap: {}, compat: {}, cost: null });
    }
    more = false;
    if (api === "anthropic-messages" && body.has_more === true && typeof body.last_id === "string") { url.searchParams.set("after_id", body.last_id); more = true; }
    if (api === "google-generative-ai" && typeof body.nextPageToken === "string" && body.nextPageToken) { url.searchParams.set("pageToken", body.nextPageToken); more = true; }
  }
  return [...models.values()];
}
