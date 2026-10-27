import type { BotColor, BotMood } from "../../contract/models.js";
/** The agent Bot (A48): the Bot created at setup, which always has this id; it cannot be deleted. */
export const AGENT_BOT_ID = "00000000-0000-4000-8000-000000000001";
export interface Bot { id: string; name: string; description: string; systemPrompt: string; connectionId: string | null; modelId: string; thinkingLevel: string; workspacePath: string; color: BotColor; mood: BotMood; createdAt: number; }
