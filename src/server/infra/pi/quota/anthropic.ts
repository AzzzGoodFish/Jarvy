import type { QuotaWindow } from "../../../../contract/models.js";
import { clamp, getJson, num, record, time, type QuotaCheck, type QuotaReading } from "./read.js";

/** Anthropic (Claude Pro/Max): the subscription's 5-hour and weekly use. The check is limited hard, so it runs only
 * when asked for; the same numbers come with every model reply as headers, which keep it current (A94). */
export const anthropic: QuotaCheck = async (credential, signal) => {
  const data = record(await getJson("https://api.anthropic.com/api/oauth/usage",
    { Authorization: `Bearer ${credential.access}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" }, signal)) ?? {};
  const windows: QuotaWindow[] = [];
  // The check gives use in percent.
  const add = (value: unknown, window: Omit<QuotaWindow, "remaining" | "resetsAt">) => {
    const entry = record(value), used = entry && num(entry.utilization);
    if (entry && used !== undefined) windows.push({ ...window, remaining: clamp(1 - used / 100), ...(time(entry.resets_at) ? { resetsAt: time(entry.resets_at)! } : {}) });
  };
  add(data.five_hour, { kind: "hours", hours: 5 });
  add(data.seven_day, { kind: "week" });
  add(data.seven_day_opus, { kind: "week", name: "Opus" });
  add(data.seven_day_sonnet, { kind: "week", name: "Sonnet" });
  return { windows };
};

/** The same use from a model reply's headers, as a share of 1 with the reset in seconds; undefined without them. */
export function anthropicHeaders(headers: Record<string, string>): QuotaReading | undefined {
  const value = (name: string) => headers[`anthropic-ratelimit-unified-${name}`] ?? headers[`Anthropic-Ratelimit-Unified-${name}`];
  const windows: QuotaWindow[] = [];
  for (const [key, window] of [["5h", { kind: "hours", hours: 5 }], ["7d", { kind: "week" }]] as const) {
    const used = num(value(`${key}-utilization`));
    if (used === undefined) continue;
    const resetsAt = time(value(`${key}-reset`));
    windows.push({ ...window, remaining: clamp(1 - used), ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows.length ? { windows } : undefined;
}
