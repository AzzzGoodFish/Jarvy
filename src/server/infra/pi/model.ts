import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { ConfiguredModel, ModelConnection } from "../../shared/models.js";
import { RuntimeFault } from "../../shared/runtime.js";

const FORMATS = new Set(["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"]);
export function installModel(runtime: ModelRuntime, connection: ModelConnection, configured: ConfiguredModel, headers: Record<string, string> = {}): Model<Api> {
  const builtin = runtime.getModel(connection.providerName, configured.id);
  const contextWindow = configured.contextWindow ?? builtin?.contextWindow;
  const maxTokens = configured.maxTokens ?? builtin?.maxTokens;
  const baseUrl = connection.baseUrl || builtin?.baseUrl || runtime.getModels(connection.providerName)[0]?.baseUrl;
  if (!contextWindow || !maxTokens) throw new RuntimeFault("model_incomplete", "请补全模型的上下文窗口和最大输出。", 422);
  if (configured.thinkingFormat && !FORMATS.has(configured.thinkingFormat)) throw new RuntimeFault("model_incomplete", "不支持此思考格式。", 422);
  // Precedence: builtin provider defaults < saved compat (catalog/autoconfig/user) < thinking format field.
  const compat = { ...builtin?.compat, ...configured.compat, ...(configured.thinkingFormat ? { thinkingFormat: configured.thinkingFormat as OpenAICompletionsCompat["thinkingFormat"] } : {}) } as Model<Api>["compat"];
  runtime.registerProvider(connection.providerName, {
    baseUrl, api: (configured.api || connection.api) as Api,
    // Secrets come from CredentialStore only; apiKey here would invoke Pi's
    // environment/command config resolver, not our literal-key contract.
    models: [{ id: configured.id, name: configured.name, api: (configured.api || connection.api) as Api, baseUrl,
      reasoning: configured.reasoning, input: configured.input, contextWindow, maxTokens,
      cost: configured.cost ?? builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: configured.thinkingLevelMap, compat }],
  });
  const model = runtime.getModel(connection.providerName, configured.id);
  if (!model) throw new RuntimeFault("model_missing", "模型不存在。", 404);
  // Literal request headers, not Pi config expressions (which may resolve shell commands).
  model.headers = { ...model.headers, ...headers };
  return model;
}

/** Public catalog metadata only; no credential or header values leave the adapter. */
export async function modelCatalog(credentials: import("@earendil-works/pi-ai").CredentialStore, providerName: string): Promise<ConfiguredModel[]> {
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  return runtime.getModels(providerName).map(publicModel);
}
export function builtinModelCatalog(providerName: string): ConfiguredModel[] {
  return (builtinProviders().find(provider => provider.id === providerName)?.getModels() ?? []).map(publicModel);
}
/** Catalog compat without thinkingFormat, which has its own field (one editable source). */
export function catalogCompat(model: Model<Api>): Record<string, unknown> {
  const { thinkingFormat: _format, ...compat } = (model.compat ?? {}) as Record<string, unknown>;
  return structuredClone(compat);
}
// Catalog listings leave compat empty: builtin connections read live SDK compat in installModel,
// and a saved snapshot would override newer SDK values after an upgrade. Autoconfigure fills it
// explicitly for connections that cannot inherit it.
export function publicModel(model: Model<Api>): ConfiguredModel {
  return {
    id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: [...model.input],
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    thinkingLevelMap: { ...model.thinkingLevelMap },
    thinkingFormat: model.compat && "thinkingFormat" in model.compat && typeof model.compat.thinkingFormat === "string" ? model.compat.thinkingFormat : "",
    compat: {},
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
  };
}
