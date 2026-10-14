/** Figure colours and moods (web/avatar/palette.ts maps them to the 3D figure). */
export const BOT_COLORS = ["gray", "blue", "green", "amber", "rose", "violet"] as const;
export const BOT_MOODS = ["normal", "happy", "sad", "angry", "dizzy"] as const;
export type BotColor = typeof BOT_COLORS[number];
export type BotMood = typeof BOT_MOODS[number];
/** The agent Bot (A48): the Bot created at setup, which always has this id; it cannot be deleted. */
export const AGENT_BOT_ID = "00000000-0000-4000-8000-000000000001";
export interface Bot { id: string; name: string; description: string; systemPrompt: string; connectionId: string | null; modelId: string; thinkingLevel: string; workspacePath: string; color: BotColor; mood: BotMood; createdAt: number; }
export interface ConfiguredModel { api?: string; headerNames?: string[]; id: string; name: string; reasoning: boolean; input: ("text" | "image")[]; contextWindow: number | null; maxTokens: number | null; thinkingFormat: string; thinkingLevelMap: Record<string, string | null>; compat: Record<string, unknown>; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; }
export interface ModelConnection { id: string; providerName: string; displayName: string; kind: "builtin" | "custom"; baseUrl: string; api: string; authType: "api_key" | "oauth"; configured: boolean; models: ConfiguredModel[]; createdAt: number; updatedAt: number; }

/** Catalog entry offered as a configuration source; data only, never credentials. */
export interface AutoconfigSource { provider: string; modelId: string; name: string; api: string; official: boolean; }
export type AutoconfigFields = Pick<ConfiguredModel, "reasoning" | "input" | "contextWindow" | "maxTokens" | "cost" | "thinkingLevelMap" | "thinkingFormat" | "compat">;
/** Result of matching a model ID against the pinned Pi catalog. Nothing is persisted. */
export type AutoconfigResult =
  | { status: "matched"; source: AutoconfigSource; reseller: boolean; apiMismatch: boolean; fields: AutoconfigFields; alternatives: AutoconfigSource[] }
  | { status: "choose"; reason: "multiple" | "similar"; options: AutoconfigSource[] }
  | { status: "none" };
