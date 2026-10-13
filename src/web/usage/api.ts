import { request } from "../api";

/** One model's usage over a period; `cost` is null when the model has no price configured. */
export interface ModelUsage {
  provider: string; model: string; calls: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null;
}
export const usageApi = {
  list: (botId: string, since: number) => request<{ since: number; models: ModelUsage[] }>(`/bots/${botId}/usage?since=${since}`),
};
