/** The agent Bot (A48). What it changed about another Bot, kept as structure until that Bot is told with its next
 * batch, where the English words are put together. `value` is the new value; a persona keeps none (it is in the prompt). */
export const CHANGE_FIELDS = ["name", "description", "persona", "model", "thinking", "run"] as const;
export type ChangeField = typeof CHANGE_FIELDS[number];
export interface BotChange { what: ChangeField; value: string | null }
/** Interface languages the browser may report with the agent's first model (A45); the welcome is written in it. */
export const WELCOME_LANGUAGES = { en: "English", zh: "Chinese" } as const;
export type WelcomeLanguage = keyof typeof WELCOME_LANGUAGES;
export const welcomeLanguage = (value: unknown): WelcomeLanguage => typeof value === "string" && Object.hasOwn(WELCOME_LANGUAGES, value) ? value as WelcomeLanguage : "en";
