import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { ENDPOINTS } from "./client.js";
import { builtinCatalog, fetchCatalog, PROVIDER } from "./models.js";
import { apiKey, login, parseApiKey, refresh } from "./oauth.js";
import { streamAntigravity } from "./stream.js";

/** Antigravity as a Pi provider of Jarvy's own (A91), registered on every model runtime beside Pi's built-in ones.
 * Without `models` it lists the built-in models, and a refresh with the network fetches the signed-in account's; a
 * Bot's runtime passes the one model it uses. */
export function antigravityProvider(models?: readonly Model<Api>[]): Provider {
  let listed: readonly Model<Api>[] = models ?? builtinCatalog().models;
  return {
    id: PROVIDER, name: "Antigravity", baseUrl: ENDPOINTS[0],
    auth: { oauth: { name: "Google Antigravity", isSubscription: true, login: interaction => login(interaction), refresh,
      toAuth: async credential => ({ apiKey: apiKey(credential) }) } },
    getModels: () => listed,
    async refreshModels(context) {
      if (models || !context.allowNetwork || context.credential?.type !== "oauth") return;
      const { token, projectId } = parseApiKey(apiKey(context.credential));
      const catalog = await fetchCatalog(token, projectId, context.signal);
      await context.publish({ update: () => { listed = catalog.models; } });
    },
    // The plain stream takes the same options without a thinking level: thinking off.
    stream: (model, context, options) => streamAntigravity(model, context, { ...options, toolChoice: undefined }),
    streamSimple: (model, context, options) => streamAntigravity(model, context, options),
  };
}
