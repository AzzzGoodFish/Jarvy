import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { AutoconfigResult, AutoconfigSource } from "../../../contract/models.js";
import { catalogCompat, publicModel } from "./model.js";

// Matching adapted from VulnHunter service/src/modules/catalog/catalog-match.ts: exact →
// namespace/date-stripped → substring, then an "official vendor" score decides. The catalog is
// Pi's, overlaid with pi.dev's newer entries (ModelCatalog, A49).
interface Row { provider: string; model: Model<Api>; official: number; }

// Model-name prefix → vendor provider words. Extend when a new vendor family appears in Pi.
const VENDORS: [RegExp, string[]][] = [
  [/^glm/i, ["zai"]], [/^deepseek/i, ["deepseek"]], [/^claude/i, ["anthropic"]], [/^(gpt|o[134](-|$)|codex)/i, ["openai"]],
  [/^kimi/i, ["kimi", "moonshot"]], [/^qwen/i, ["qwen"]], [/^gemini|^gemma/i, ["google"]], [/^grok/i, ["xai"]],
  [/^(mistral|mixtral|codestral|devstral|magistral)/i, ["mistral"]], [/llama/i, ["meta"]], [/^minimax/i, ["minimax"]], [/^mimo/i, ["xiaomi"]],
];
const vendorWords = (id: string) => VENDORS.find(([pattern]) => pattern.test(id))?.[1] ?? [];
/** 2 = bare ID from the vendor's own provider; 1 = one of the two; 0 = reseller namespace. */
function officialScore(provider: string, id: string): number {
  const words = vendorWords(id);
  return (id.includes("/") ? 0 : 1) + (words.some(word => provider.includes(word)) ? 1 : 0);
}
const strip = (id: string) => id.toLowerCase().replace(/^.*\//, "").replace(/-(\d{6,8})$/, "");

function rows(providers: readonly Provider[]): Row[] {
  return providers.flatMap(provider => provider.getModels().map(model => ({ provider: provider.id, model, official: officialScore(provider.id, model.id) })));
}
const source = (row: Row): AutoconfigSource => ({ provider: row.provider, modelId: row.model.id, name: row.model.name, api: row.model.api, official: row.official === 2 });
/** Richer catalog entries first when only resellers carry the model. */
const completeness = (row: Row) => Object.values(row.model.thinkingLevelMap ?? {}).filter(value => value !== undefined).length
  + Object.keys(row.model.compat ?? {}).length + (row.model.cost.input > 0 ? 1 : 0);

function candidates(all: Row[], query: string): Row[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  // Exact and namespace/date-stripped IDs name the same model ("zai-org/GLM-5.3" ≈ zai "glm-5.3"),
  // so they are ranked together; substring hits are only a fallback.
  const same = all.filter(row => row.model.id.toLowerCase() === q || strip(row.model.id) === strip(q));
  return same.length ? same : all.filter(row => row.model.id.toLowerCase().includes(strip(q)));
}

function similar(all: Row[], query: string): Row[] {
  const q = strip(query);
  // Require a shared 3-character prefix so unrelated private model names get "none", not noise.
  return all.map(row => ({ row, ...similarity(strip(row.model.id), q) })).filter(item => item.prefix >= 3)
    .sort((a, b) => b.score - a.score || b.row.official - a.row.official).slice(0, 5).map(item => item.row);
}
function similarity(a: string, b: string) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return { prefix, score: prefix / (1 + levenshtein(a, b) / 8) };
}
function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}

function matched(row: Row, api: string, alternatives: Row[], reseller: boolean): AutoconfigResult {
  const model = publicModel(row.model);
  // thinkingFormat and compat are protocol-specific; copying another protocol's flags would
  // silently change request shape, so only reuse them when the protocol is the same.
  const sameApi = row.model.api === api;
  return { status: "matched", source: source(row), reseller, apiMismatch: !sameApi,
    fields: { reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost,
      thinkingLevelMap: model.thinkingLevelMap, thinkingFormat: sameApi ? model.thinkingFormat : "", compat: sameApi ? catalogCompat(row.model) : {} },
    alternatives: alternatives.filter(item => item !== row).slice(0, 8).map(source) };
}

/** Match a model ID against the catalog. `choice` applies a source the user picked. */
export function autoconfigure(providers: readonly Provider[], modelId: string, api: string, choice?: { provider: string; modelId: string }): AutoconfigResult {
  const all = rows(providers), hits = candidates(all, modelId);
  if (choice) {
    const row = all.find(item => item.provider === choice.provider && item.model.id === choice.modelId);
    if (row) return matched(row, api, hits, row.official < 2);
  }
  if (!hits.length) {
    const options = similar(all, modelId);
    return options.length ? { status: "choose", reason: "similar", options: options.map(source) } : { status: "none" };
  }
  const official = hits.filter(row => row.official === 2);
  const ranked = [...hits].sort((a, b) => b.official - a.official || completeness(b) - completeness(a));
  if (official.length === 1) return matched(official[0]!, api, ranked, false);
  if (official.length > 1) {
    // Same vendor, several official partitions (zai vs zai-coding-cn): the provider whose ID is
    // exactly the vendor word, or else the only one speaking the requested protocol, wins.
    const words = vendorWords(official[0]!.model.id);
    const exact = official.filter(row => words.includes(row.provider));
    const sameApi = official.filter(row => row.model.api === api);
    const winner = exact.length === 1 ? exact[0] : sameApi.length === 1 ? sameApi[0] : undefined;
    if (winner) return matched(winner, api, ranked, false);
    return { status: "choose", reason: "multiple", options: official.sort((a, b) => a.provider.length - b.provider.length).map(source) };
  }
  return matched(ranked[0]!, api, ranked, true);
}
