import { request } from "../api";
import type { ModelUsage, UsageOverview } from "../../contract/usage";

export const usageApi = {
  /** One Bot's usage per model since a time (A46). */
  list: (botId: string, since: number) => request<{ since: number; models: ModelUsage[] }>(`/bots/${botId}/usage?since=${since}`),
  /** Every Bot's usage, per model and per Bot (A81). */
  overview: (since: number) => request<UsageOverview>(`/usage?since=${since}`),
};
