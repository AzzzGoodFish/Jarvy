import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { antigravityProvider } from "./antigravity/provider.js";

/** Providers of Jarvy's own, beside the ones Pi has built in (A91): Pi objects like those, by ID. */
const OWN: Record<string, (models?: readonly Model<Api>[]) => Provider> = { antigravity: antigravityProvider };

/** One of Jarvy's own providers, listing `models` instead of its own when given; undefined for Pi's. */
export const ownProvider = (id: string, models?: readonly Model<Api>[]): Provider | undefined => OWN[id]?.(models);
export const ownProviders = (): Provider[] => Object.values(OWN).map(make => make());
export const allProviders = (): Provider[] => [...builtinProviders(), ...ownProviders()];

/** Pi's model runtime with Jarvy's own providers registered on it: every runtime Jarvy makes comes from here. */
export async function createRuntime(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create(options);
  for (const provider of ownProviders()) runtime.registerNativeProvider(provider);
  return runtime;
}
