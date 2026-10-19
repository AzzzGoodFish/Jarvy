/** Provider logos (fish m1018): SVGs from LobeHub's lobe-icons (MIT, see licenses/LOBE-ICONS-MIT.txt), copied as files
 * with their size, style and title removed. A brand's colour version where it has one; single-colour logos fill with
 * currentColor, so they follow the theme. Each is a trusted local file, inlined as markup. */
const FILES = import.meta.glob<string>("./*.svg", { query: "?raw", import: "default", eager: true });

/** Built-in provider ID (Pi's catalog) → its brand's logo. An ID not listed — Radius, a custom provider, a provider a
 * later Pi adds — keeps the letter badge. */
const BRANDS: Record<string, string> = {
  "amazon-bedrock": "bedrock", "ant-ling": "antgroup", anthropic: "anthropic", azure: "azure", baseten: "baseten", cerebras: "cerebras",
  "cloudflare-ai-gateway": "cloudflare", "cloudflare-workers-ai": "cloudflare", deepseek: "deepseek", fireworks: "fireworks",
  "github-copilot": "githubcopilot", google: "google", "google-vertex": "vertexai", groq: "groq", huggingface: "huggingface",
  "kimi-coding": "kimi", meta: "meta", minimax: "minimax", "minimax-cn": "minimax", mistral: "mistral", moonshotai: "moonshot",
  "moonshotai-cn": "moonshot", nvidia: "nvidia", openai: "openai", "openai-codex": "openai", opencode: "opencode", "opencode-go": "opencode",
  openrouter: "openrouter", "qwen-token-plan": "qwen", "qwen-token-plan-cn": "qwen", "qwen-token-plan-individual": "qwen", together: "together",
  "vercel-ai-gateway": "vercel", xai: "xai", xiaomi: "xiaomimimo", "xiaomi-token-plan-ams": "xiaomimimo", "xiaomi-token-plan-cn": "xiaomimimo",
  "xiaomi-token-plan-sgp": "xiaomimimo", zai: "zai", "zai-coding-cn": "zai",
};

export const providerLogo = (provider: string | undefined): string | undefined => provider && BRANDS[provider] ? FILES[`./${BRANDS[provider]}.svg`] : undefined;
