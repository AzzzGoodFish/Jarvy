import type { Api, Model } from "@earendil-works/pi-ai";

type Cost = Model<Api>["cost"];

/** Whose API sells a model of the same name: Gemini is Google's, Claude is Anthropic's. */
const MAKERS: [RegExp, string][] = [[/^gemini-/i, "google"], [/^claude-/i, "anthropic"]];

/** Prices, in USD per million tokens, for models the catalog doesn't list under their maker. Gemini 4 Hydrogen at the
 * rate Google publishes for it, until pi.dev lists it; GPT-OSS, which OpenAI sells no API for, at pi-antigravity's. */
const KNOWN: Record<string, Cost> = {
  "gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
  "gpt-oss-120b": { input: 0.6, output: 2.4, cacheRead: 0.15, cacheWrite: 0.6 },
};

/** An Antigravity model's price (A91): what its maker's own API charges for the model of the same ID — or its preview,
 * as Google sells `gemini-3.1-pro` — as `listed` reads it from the model catalog (Pi's, with pi.dev's newer entries);
 * else the one known here; else none. */
export function antigravityPrice(id: string, listed: (provider: string, id: string) => Cost | undefined): Cost | undefined {
  const maker = MAKERS.find(([pattern]) => pattern.test(id))?.[1];
  const found = maker ? listed(maker, id) ?? listed(maker, `${id}-preview`) : undefined;
  return found ? structuredClone(found) : KNOWN[id] && { ...KNOWN[id] };
}
