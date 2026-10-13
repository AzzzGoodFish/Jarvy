import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export function providerCatalog() {
  return builtinProviders().flatMap(provider => {
    const models = provider.getModels();
    // This is a chat-model selector. Keep empty dynamic catalogs, not image/classifier-only providers.
    if (!models.length && provider.getAllModels?.().length) return [];
    const common = { id: provider.id, api: models[0]?.api ?? "openai-completions", modelCount: models.length };
    return [
      ...(provider.auth.oauth ? [{ ...common, name: provider.auth.oauth.name, authType: "oauth" as const }] : []),
      ...(provider.auth.apiKey?.login ? [{ ...common, name: provider.name, authType: "api_key" as const }] : []),
    ];
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export const modelApis = new Set(builtinProviders().flatMap(provider => provider.getModels().map(model => model.api)));
