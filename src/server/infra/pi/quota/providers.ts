import type { QuotaWindow } from "../../../../contract/models.js";
import { fetchModels } from "../antigravity/client.js";
import { apiKey, parseApiKey } from "../antigravity/oauth.js";
import { clamp, getJson, num, record, span, time, type Json, type QuotaCheck, type QuotaReading } from "./read.js";

/** Antigravity: each model of the account's list carries its pool's remaining share and reset time (A91). Models of a
 * family share a pool, so they are shown by family, each at its lowest. */
export const antigravity: QuotaCheck = async (credential, signal) => {
  const { token, projectId } = parseApiKey(apiKey(credential));
  const { models } = await fetchModels(token, projectId, signal);
  const pools = new Map<string, QuotaWindow>();
  for (const [id, info] of Object.entries(models)) {
    const quota = record(info.quotaInfo), name = family(id);
    if (!quota || !name) continue;
    // An exhausted pool leaves the share out.
    const window: QuotaWindow = { kind: "pool", name, remaining: clamp(num(quota.remainingFraction) ?? 0), resetsAt: time(quota.resetTime) };
    const kept = pools.get(name);
    if (!kept || window.remaining < kept.remaining) pools.set(name, window);
  }
  return { windows: [...pools.values()].sort((a, b) => ORDER.indexOf(a.name!) - ORDER.indexOf(b.name!)) };
};
const ORDER = ["Gemini Flash", "Gemini Pro", "Gemini", "Claude", "GPT-OSS"];
function family(id: string): string | undefined {
  const lower = id.toLowerCase();
  if (lower.startsWith("gemini")) return lower.includes("flash") ? "Gemini Flash" : lower.includes("pro") ? "Gemini Pro" : "Gemini";
  if (lower.startsWith("claude")) return "Claude";
  if (lower.startsWith("gpt-oss")) return "GPT-OSS";
  return undefined;
}

/** Kimi Code: the weekly limit, and the shorter ones in `limits`, as Kimi CLI reads them. */
export const kimi: QuotaCheck = async (credential, signal) => {
  const data = record(await getJson("https://api.kimi.com/coding/v1/usages", { Authorization: `Bearer ${credential.access}` }, signal)) ?? {};
  const windows: QuotaWindow[] = [];
  const limits = Array.isArray(data.limits) ? data.limits : [];
  for (const item of limits.map(record)) {
    if (!item) continue;
    const detail = record(item.detail) ?? item, window = record(item.window) ?? {};
    const length = kimiSpan(num(window.duration ?? item.duration ?? detail.duration), String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? ""));
    const read = kimiLimit(detail);
    if (read && length) windows.push({ ...length, ...read });
  }
  const weekly = record(data.usage) && kimiLimit(record(data.usage)!);
  if (weekly) windows.push({ kind: "week", ...weekly });
  return { windows };
};
function kimiLimit(data: Json): Pick<QuotaWindow, "remaining" | "resetsAt"> | undefined {
  const limit = num(data.limit);
  if (!limit) return undefined;
  const used = num(data.used) ?? (num(data.remaining) !== undefined ? limit - num(data.remaining)! : undefined);
  if (used === undefined) return undefined;
  return { remaining: clamp(1 - used / limit), resetsAt: time(data.resetTime ?? data.reset_time ?? data.resetAt ?? data.reset_at) };
}
function kimiSpan(duration: number | undefined, unit: string) {
  if (!duration) return undefined;
  const seconds = unit.includes("MINUTE") ? duration * 60 : unit.includes("HOUR") ? duration * 3600 : unit.includes("DAY") ? duration * 86400 : duration;
  return span(seconds);
}

/** OpenAI Codex (ChatGPT Plus/Pro): the usage the Codex CLI reads, a short window and a weekly one, and any other
 * limit of the plan by its name. */
export const codex: QuotaCheck = async (credential, signal) => {
  const account = typeof credential.accountId === "string" && credential.accountId ? credential.accountId : accountIn(credential.access);
  if (!account) throw new Error("The sign-in has no ChatGPT account; sign in again.");
  const data = record(await getJson("https://chatgpt.com/backend-api/wham/usage",
    { Authorization: `Bearer ${credential.access}`, "chatgpt-account-id": account, originator: "pi" }, signal)) ?? {};
  const windows = codexWindows(record(data.rate_limit));
  const others = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  for (const other of others.map(record)) if (other) {
    const name = typeof other.limit_name === "string" ? other.limit_name : undefined;
    windows.push(...codexWindows(record(other.rate_limit)).map(window => ({ ...window, ...(name ? { name } : {}) })));
  }
  return { windows, ...(typeof data.plan_type === "string" ? { plan: data.plan_type } : {}) };
};
function codexWindows(limit: Json | undefined): QuotaWindow[] {
  if (!limit) return [];
  return [record(limit.primary_window), record(limit.secondary_window)].flatMap(window => {
    const length = window && span(num(window.limit_window_seconds)), used = window && num(window.used_percent);
    return length && used !== undefined ? [{ ...length, remaining: clamp(1 - used / 100), resetsAt: time(window.reset_at) }] : [];
  });
}
/** The ChatGPT account in the access token's claims. */
function accountIn(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch { return undefined; }
}

/** GitHub Copilot: the plan's monthly snapshots, read with the GitHub sign-in (the credential's refresh token) as the
 * Copilot extension reads them; unlimited ones are left out. */
export const copilot: QuotaCheck = async (credential, signal) => {
  const domain = typeof credential.enterpriseUrl === "string" && credential.enterpriseUrl ? hostOf(credential.enterpriseUrl) : "github.com";
  const data = record(await getJson(`https://api.${domain}/copilot_internal/user`, { Authorization: `token ${credential.refresh}`, ...COPILOT_HEADERS }, signal)) ?? {};
  const resetsAt = time(data.quota_reset_date_utc ?? data.quota_reset_date ?? data.limited_user_reset_date);
  const windows: QuotaWindow[] = [];
  const snapshots = record(data.quota_snapshots);
  if (snapshots) for (const name of ["premium_interactions", "chat", "completions"] as const) {
    const snapshot = record(snapshots[name]);
    const percent = snapshot && num(snapshot.percent_remaining);
    if (!snapshot || snapshot.unlimited === true || percent === undefined) continue;
    const total = num(snapshot.entitlement), left = num(snapshot.remaining ?? snapshot.quota_remaining);
    windows.push({ kind: "month", name: name === "premium_interactions" ? "premium" : name, remaining: clamp(percent / 100),
      ...(total && left !== undefined ? { amount: { left: Math.max(0, left), total, unit: "requests" as const } } : {}), ...(resetsAt ? { resetsAt } : {}) });
  }
  // Copilot Free without snapshots: what is left of the monthly allowance.
  const left = record(data.limited_user_quotas), total = record(data.monthly_quotas);
  if (!windows.length && left && total) for (const name of ["chat", "completions"] as const) {
    const remaining = num(left[name]), allowance = num(total[name]);
    if (remaining !== undefined && allowance) windows.push({ kind: "month", name, remaining: clamp(remaining / allowance),
      amount: { left: remaining, total: allowance, unit: "requests" }, ...(resetsAt ? { resetsAt } : {}) });
  }
  return { windows, ...(typeof data.copilot_plan === "string" ? { plan: data.copilot_plan } : {}) };
};
/** The headers Pi's Copilot sign-in sends GitHub's Copilot API. */
const COPILOT_HEADERS = { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" };
function hostOf(value: string): string {
  try { return new URL(value.includes("://") ? value : `https://${value}`).hostname; } catch { return "github.com"; }
}

/** OpenRouter: the account's credits, bought and used; without the right to read them, the key's own limit. */
export const openrouter: QuotaCheck = async (credential, signal) => {
  const headers = { Authorization: `Bearer ${credential.access}` };
  try {
    const data = record(record(await getJson("https://openrouter.ai/api/v1/credits", headers, signal))?.data) ?? {};
    const total = num(data.total_credits), used = num(data.total_usage) ?? 0;
    if (total) return { windows: [{ kind: "credits", remaining: clamp((total - used) / total), amount: { left: Math.max(0, total - used), total, unit: "usd" } }] };
    return { windows: [] };
  } catch (error) {
    signal.throwIfAborted();
    const data = record(record(await getJson("https://openrouter.ai/api/v1/key", headers, signal).catch(() => { throw error; }))?.data) ?? {};
    const limit = num(data.limit), left = num(data.limit_remaining);
    return { windows: limit && left !== undefined ? [{ kind: "credits", remaining: clamp(left / limit), amount: { left: Math.max(0, left), total: limit, unit: "usd" } }] : [] };
  }
};

/** The same windows from a Codex reply's headers (`x-codex-primary-*`, `x-codex-secondary-*`), in percent with the
 * reset in seconds; undefined without them. */
export function codexHeaders(headers: Record<string, string>): QuotaReading | undefined {
  const windows = (["primary", "secondary"] as const).flatMap(which => {
    const used = num(headers[`x-codex-${which}-used-percent`]), minutes = num(headers[`x-codex-${which}-window-minutes`]);
    const length = minutes ? span(minutes * 60) : undefined, resetsAt = time(headers[`x-codex-${which}-reset-at`]);
    return used !== undefined && length ? [{ ...length, remaining: clamp(1 - used / 100), ...(resetsAt ? { resetsAt } : {}) }] : [];
  });
  return windows.length ? { windows } : undefined;
}
