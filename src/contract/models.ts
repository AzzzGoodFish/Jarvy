/** Models, connections and the Bot's look as the interface sees them (A49, A62). */
/** Figure colours and moods (web/avatar/palette.ts maps them to the 3D figure). */
export const BOT_COLORS = ["gray", "blue", "green", "amber", "rose", "violet"] as const;
export const BOT_MOODS = ["normal", "happy", "sad", "angry", "dizzy"] as const;
export type BotColor = typeof BOT_COLORS[number];
export type BotMood = typeof BOT_MOODS[number];
export interface ConfiguredModel { api?: string; /** The address its catalog entry gives, kept with it (A62); the connection's own address comes first. */ baseUrl?: string; headerNames?: string[]; id: string; name: string; reasoning: boolean; input: ("text" | "image")[]; contextWindow: number | null; maxTokens: number | null; thinkingFormat: string; thinkingLevelMap: Record<string, string | null>; compat: Record<string, unknown>; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; }
export interface ModelConnection { id: string; providerName: string; displayName: string; kind: "builtin" | "custom"; baseUrl: string; api: string; authType: "api_key" | "oauth"; configured: boolean; models: ConfiguredModel[]; createdAt: number; updatedAt: number; }

/** What resetting a built-in connection's models to the catalog does (A62): the saved models it sets to their catalog
 * entries, and the ones it removes (not in the catalog), with the Bots that will need another model. */
export interface ModelResetPlan { reset: string[]; removed: { id: string; name: string; bots: string[] }[] }

/** Catalog entry offered as a configuration source; data only, never credentials. */
export interface AutoconfigSource { provider: string; modelId: string; name: string; api: string; official: boolean; }
export type AutoconfigFields = Pick<ConfiguredModel, "reasoning" | "input" | "contextWindow" | "maxTokens" | "cost" | "thinkingLevelMap" | "thinkingFormat" | "compat">;
/** Result of matching a model ID against the pinned Pi catalog. Nothing is persisted. */
export type AutoconfigResult =
  | { status: "matched"; source: AutoconfigSource; reseller: boolean; apiMismatch: boolean; fields: AutoconfigFields; alternatives: AutoconfigSource[] }
  | { status: "choose"; reason: "multiple" | "similar"; options: AutoconfigSource[] }
  | { status: "none" };
/** A model as the page sends it: `headerUpdates` sets (a string) or removes (null) request headers; values are never read back. */
export type ModelInput = ConfiguredModel & { headerUpdates?: Record<string, string | null> };
/** A provider the owner can connect, with how it logs in and its default protocol. */
export interface ProviderOption { id: string; name: string; authType: "oauth" | "api_key"; api: string; modelCount: number; }
/** A model a Bot can be given, per connection, with the thinking levels it takes. */
export interface BotModelGroup { id: string; name: string; models: { id: string; name: string; thinking: { levels: string[] }; thinkingLevelMap: Record<string, string | null> }[]; }
/** A subscription login in progress (OAuth): what to show the owner next. */
export interface LoginState {
  phase: "idle" | "running" | "completed" | "cancelled" | "error";
  prompt?: { id: string; type: "select" | "text" | "secret" | "manual_code"; message: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] };
  event?: { type: "auth_url"; url: string; instructions?: string } | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
    | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] } | { type: "progress"; message: string };
}
