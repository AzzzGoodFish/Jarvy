import type { QuotaCheck, QuotaReading } from "./read.js";
import { antigravity, codex, codexHeaders, copilot, kimi, openrouter } from "./providers.js";
import { anthropic, anthropicHeaders } from "./anthropic.js";

export { QuotaHttpError, type QuotaReading } from "./read.js";

/** The subscription providers whose limits Jarvy can read (A94), by Pi provider ID. */
const CHECKS: Record<string, QuotaCheck> = { antigravity, "kimi-coding": kimi, "openai-codex": codex, "github-copilot": copilot, openrouter, anthropic };
/** Providers that can't tell their limits, with the page that shows them. */
const PAGES: Record<string, string> = { openai: "https://chatgpt.com/settings/usage" };
/** Providers whose model replies carry the limits. */
const REPLIES: Record<string, (headers: Record<string, string>) => QuotaReading | undefined> = { anthropic: anthropicHeaders, "openai-codex": codexHeaders, openai: codexHeaders };
/** Checks that are limited hard: only when asked for, never on opening the page. */
const ON_REQUEST = new Set(["anthropic"]);

export const quotaCheck = (provider: string): QuotaCheck | undefined => CHECKS[provider];
export const quotaPage = (provider: string): string | undefined => PAGES[provider];
export const quotaFromReply = (provider: string, headers: Record<string, string>): QuotaReading | undefined => REPLIES[provider]?.(headers);
export const checkOnRequest = (provider: string): boolean => ON_REQUEST.has(provider);
