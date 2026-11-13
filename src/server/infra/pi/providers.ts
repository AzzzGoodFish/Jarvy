import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { antigravityProvider } from "./antigravity/provider.js";
import { antigravityPrice } from "./antigravity/prices.js";

/** Providers of Jarvy's own, beside the ones Pi has built in (A91): Pi objects like those, by ID. */
const OWN: Record<string, (models?: readonly Model<Api>[]) => Provider> = { antigravity: antigravityProvider };
/** Where an own provider's models take their price from, given the catalog's entries by provider and model ID. */
type Price = (id: string, listed: (provider: string, id: string) => Model<Api>["cost"] | undefined) => Model<Api>["cost"] | undefined;
const PRICES: Record<string, Price> = { antigravity: antigravityPrice };

/** One of Jarvy's own providers, listing `models` instead of its own when given; undefined for Pi's. */
export const ownProvider = (id: string, models?: readonly Model<Api>[]): Provider | undefined => OWN[id]?.(models);
export const ownProviders = (): Provider[] => Object.values(OWN).map(make => make());
export const allProviders = (): Provider[] => [...builtinProviders(), ...ownProviders()];
/** An own provider's model with its price, read from the catalog's `listed` entries; unchanged without one. */
export function priceOwn<T extends Model<Api>>(providerId: string, model: T, listed: Parameters<Price>[1]): T {
  const cost = PRICES[providerId]?.(model.id, listed);
  return cost ? { ...model, cost } : model;
}

/** Pi's model runtime with Jarvy's own providers registered on it: every runtime Jarvy makes comes from here. */
export async function createRuntime(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create(options);
  for (const provider of ownProviders()) runtime.registerNativeProvider(provider);
  return runtime;
}
