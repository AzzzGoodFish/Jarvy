import type { BotUsage, ModelUsage, UsageOverview } from "../../../contract/usage.js";

type Tally = Omit<ModelUsage, "provider" | "model">;
const empty = (): Tally => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
/** Adds one row into a tally. A cost stays null until a priced row comes, so unpriced models never read as free (A46). */
function add(into: Tally, row: Tally): void {
  into.calls += row.calls; into.input += row.input; into.output += row.output;
  into.cacheRead += row.cacheRead; into.cacheWrite += row.cacheWrite;
  if (row.cost !== null) into.cost = (into.cost ?? 0) + row.cost;
}
const costly = (a: Tally, b: Tally) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls;

/** Every Bot's usage since a time (A81): each Bot's per-model rows summed per model across Bots, and per Bot across
 * its models. Bots with no calls in the period are left out; both lists are most expensive first. */
export function usageOverview(since: number, perBot: readonly (readonly [botId: string, models: ModelUsage[]])[]): UsageOverview {
  const models = new Map<string, ModelUsage>(), bots: BotUsage[] = [];
  for (const [botId, rows] of perBot) {
    if (!rows.length) continue;
    const bot: BotUsage = { botId, ...empty() };
    for (const { provider, model, ...row } of rows) {
      const key = `${provider}\u0000${model}`;
      add(models.get(key) ?? models.set(key, { provider, model, ...empty() }).get(key)!, row);
      add(bot, row);
    }
    bots.push(bot);
  }
  return { since, models: [...models.values()].sort(costly), bots: bots.sort(costly) };
}
