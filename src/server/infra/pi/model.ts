import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OpenAICompletionsCompat, Provider } from "@earendil-works/pi-ai";
import type { ModelCatalog } from "./catalog.js";
import type { ConfiguredModel, ModelConnection } from "../../shared/models.js";
import { RuntimeFault } from "../../shared/runtime.js";

const FORMATS = new Set(["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"]);
/** Registers a saved model with the session's Pi runtime. What the saved model leaves out — its compat flags, and the
 * address, context window, max output and price when not filled in — comes from the catalog entry with the same ID and
 * protocol: pi.dev's newer one if `catalog` has it, else the one Pi bundles (A49, A62). Compat is never saved from the
 * catalog, so a newer entry reaches models already saved. */
export function installModel(runtime: ModelRuntime, connection: ModelConnection, configured: ConfiguredModel, headers: Record<string, string> = {}, catalog?: ModelCatalog): Model<Api> {
  const api = (configured.api || connection.api) as Api;
  const bundled = runtime.getModel(connection.providerName, configured.id);
  const listed = catalog?.overlay(connection.providerName, bundled ? [bundled] : []).find(model => model.id === configured.id);
  const builtin = listed?.api === api ? listed : bundled;
  const contextWindow = configured.contextWindow ?? builtin?.contextWindow;
  const maxTokens = configured.maxTokens ?? builtin?.maxTokens;
  // The connection's own address first; then the one saved with the model from the catalog (A62), which goes with its
  // protocol; then Pi's bundled entry.
  const baseUrl = connection.baseUrl || configured.baseUrl || builtin?.baseUrl || runtime.getModels(connection.providerName)[0]?.baseUrl;
  if (!contextWindow || !maxTokens) throw new RuntimeFault("model_incomplete", "Fill in the model's context window and max output.", 422);
  if (configured.thinkingFormat && !FORMATS.has(configured.thinkingFormat)) throw new RuntimeFault("thinking_format", "This thinking format isn't supported.", 422);
  // Precedence: builtin provider defaults < saved compat (catalog/autoconfig/user) < thinking format field.
  const compat = { ...builtin?.compat, ...configured.compat, ...(configured.thinkingFormat ? { thinkingFormat: configured.thinkingFormat as OpenAICompletionsCompat["thinkingFormat"] } : {}) } as Model<Api>["compat"];
  runtime.registerProvider(connection.providerName, {
    baseUrl, api,
    // Secrets come from CredentialStore only; apiKey here would invoke Pi's
    // environment/command config resolver, not our literal-key contract.
    models: [{ id: configured.id, name: configured.name, api, baseUrl,
      reasoning: configured.reasoning, input: configured.input, contextWindow, maxTokens,
      cost: configured.cost ?? builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: configured.thinkingLevelMap, compat }],
  });
  const model = runtime.getModel(connection.providerName, configured.id);
  if (!model) throw new RuntimeFault("model_missing", "Model not found", 404);
  // Literal request headers, not Pi config expressions (which may resolve shell commands).
  model.headers = { ...model.headers, ...headers };
  return model;
}

/** Public catalog metadata only; no credential or header values leave the adapter. A connection's catalog takes the
 * model catalog's newer entries too (A49). */
export async function modelCatalog(credentials: import("@earendil-works/pi-ai").CredentialStore, providerName: string, catalog: ModelCatalog): Promise<ConfiguredModel[]> {
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  return catalog.overlay(providerName, runtime.getModels(providerName)).map(publicModel);
}
export function providerModels(providers: readonly Provider[], providerName: string): ConfiguredModel[] {
  return (providers.find(provider => provider.id === providerName)?.getModels() ?? []).map(publicModel);
}
/** Catalog compat without thinkingFormat, which has its own field (one editable source). */
export function catalogCompat(model: Model<Api>): Record<string, unknown> {
  const { thinkingFormat: _format, ...compat } = (model.compat ?? {}) as Record<string, unknown>;
  return structuredClone(compat);
}
// Catalog listings leave compat empty: built-in connections read it live from the catalog entry in installModel,
// and a saved snapshot would override newer values after an upgrade. Autoconfigure fills it
// explicitly for connections that cannot inherit it.
export function publicModel(model: Model<Api>): ConfiguredModel {
  return {
    id: model.id, name: model.name, api: model.api, ...(typeof model.baseUrl === "string" && model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    reasoning: model.reasoning, input: [...model.input],
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    thinkingLevelMap: { ...model.thinkingLevelMap },
    thinkingFormat: model.compat && "thinkingFormat" in model.compat && typeof model.compat.thinkingFormat === "string" ? model.compat.thinkingFormat : "",
    compat: {},
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
  };
}
