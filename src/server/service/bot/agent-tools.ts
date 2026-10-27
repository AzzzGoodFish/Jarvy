import { ChatError } from "../../shared/chat.js";
import { type QuestionSpec } from "../../../contract/chat.js";
import type { ChatTools } from "./chat-tools.js";
import type { AgentOps, BotSettings } from "./agent.js";
import type { AgentToolName } from "./agent-schemas.js";

type Asked = { status: "answered"; selected: { label: string; value: string }[] } | { status: "dismissed" };
type Confirm = { askIn: string; question: string; confirm: string; cancel: string };
type Ask = (chatId: string, question: QuestionSpec) => Promise<Asked>;
type Scope = { ops: AgentOps; tools: ChatTools };

/** The agent Bot's tools (A48). A deletion is a step of the tool: the owner's card, then the deletion only if they
 * confirmed; it never rests on the prompt. */
export class AgentTools {
  constructor(private readonly scope: Scope) {}
  private get ops() { return this.scope.ops; }
  private async confirmed(input: Confirm, ask: Ask): Promise<{ deleted: false; answer: "cancelled" | "dismissed" } | null> {
    const chat = this.scope.tools.chat(input.askIn);
    if (!chat.memberIds.includes(this.ops.owner)) throw new ChatError(400, "The owner is not in askIn; use a chat they are in, such as your DM with them");
    const answer = await ask(chat.id, { question: input.question, multiple: false, allowCustom: false,
      options: [{ label: input.confirm, value: "confirm", style: "danger" }, { label: input.cancel, value: "cancel" }] });
    if (answer.status === "dismissed") return { deleted: false, answer: "dismissed" };
    return answer.selected[0]?.value === "confirm" ? null : { deleted: false, answer: "cancelled" };
  }
  private channel(chatId: string) {
    const chat = this.scope.tools.chat(chatId);
    if (chat.type !== "channel") throw new ChatError(400, "Not a channel");
    return chat;
  }
  async call(name: AgentToolName, args: Record<string, unknown>, ask: Ask) {
    switch (name) {
      case "models.list": return this.ops.models();
      case "bots.create": {
        const { environment, ...settings } = args as unknown as BotSettings & { name: string; environment?: "sandbox" | "host" };
        const bot = await this.ops.create({ ...settings, ...(environment ? { environment: environment === "sandbox" ? "computer" as const : "host" as const } : {}) });
        return { name: bot.name, model: bot.connectionId ? this.ops.modelLabel(bot) : null, thinking: bot.thinkingLevel, environment: this.ops.environment(bot.id) === "computer" ? "sandbox" : "host" };
      }
      case "bots.update": {
        const { bot, ...settings } = args as unknown as BotSettings & { bot: string };
        const result = await this.ops.update(this.ops.bot(bot), settings);
        return { name: result.bot.name, changed: result.changed };
      }
      case "bots.start": case "bots.stop": {
        const bot = this.ops.bot((args as { bot: string }).bot);
        return { name: bot.name, status: await this.ops.run(bot, name === "bots.start" ? "start" : "stop") };
      }
      case "bots.usage": {
        const input = args as { bot: string; days?: number }, bot = this.ops.bot(input.bot);
        return { name: bot.name, ...this.ops.usage(bot, input.days ?? 7) };
      }
      case "bots.delete": {
        const input = args as Confirm & { bot: string }, bot = this.ops.bot(input.bot);
        if (bot.id === this.ops.agentId) throw new ChatError(400, "You can't delete yourself");
        const declined = await this.confirmed(input, ask);
        if (declined) return declined;
        await this.ops.deleteBot(this.ops.bot(input.bot));
        return { deleted: true, name: bot.name };
      }
      case "chats.delete": {
        const input = args as Confirm & { chatId: string }, chat = this.channel(input.chatId);
        const declined = await this.confirmed(input, ask);
        if (declined) return declined;
        await this.ops.deleteChannel(chat.id);
        return { deleted: true, name: chat.title };
      }
      case "chats.removeMembers": {
        const input = args as Confirm & { chatId: string; members: string[] }, chat = this.channel(input.chatId);
        const members = this.scope.tools.members(input.members).filter(member => chat.memberIds.includes(member.id));
        if (!members.length) throw new ChatError(400, "None of them is in this channel");
        const declined = await this.confirmed(input, ask);
        if (declined) return { removed: [], answer: declined.answer };
        for (const member of members) this.ops.removeMember(chat.id, member.id);
        return { removed: members.map(member => member.name) };
      }
      case "sections.delete": {
        const input = args as Confirm & { section: string }, section = this.scope.tools.section(input.section);
        const declined = await this.confirmed(input, ask);
        if (declined) return declined;
        this.ops.deleteSection(section);
        return { deleted: true };
      }
    }
  }
}
