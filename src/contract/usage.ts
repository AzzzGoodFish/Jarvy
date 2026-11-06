/** Model usage as the interface sees it (A46, A81): tokens and cost from Bots' History. */

/** One model's calls over a period, summed from History. `cost` is null when no call of it was priced (its configured
 * price is zero or missing), so an unpriced model never reads as free. */
export interface ModelUsage {
  provider: string; model: string; calls: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null;
}
/** One Bot's calls over a period, all models together; `cost` as for a model. */
export interface BotUsage {
  botId: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null;
}
/** Every Bot's usage since a time: per model across Bots, and per Bot across models; most expensive first. */
export interface UsageOverview { since: number; models: ModelUsage[]; bots: BotUsage[] }
