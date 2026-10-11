import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConfiguredModel } from "../../shared/models.js";

// Pi 0.99.1 core/defaults.js uses medium; this constant is not publicly exported.
// Keep this adapter aligned when upgrading Pi; never read the host's settings.
const PI_DEFAULT_THINKING: ModelThinkingLevel = "medium";
// These two Pi helpers only read reasoning/thinkingLevelMap in the pinned SDK.
// Capability projection avoids inventing token limits or creating an Agent for a menu.
function capabilities(model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">): Model<Api> {
  return { reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap } as Model<Api>;
}
export function thinkingOptions(model: ConfiguredModel) {
  return { levels: getSupportedThinkingLevels(capabilities(model)) };
}
export function resolveThinking(model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">, choice: string): ModelThinkingLevel {
  return clampThinkingLevel(capabilities(model), choice === "auto" ? PI_DEFAULT_THINKING : choice as ModelThinkingLevel);
}
