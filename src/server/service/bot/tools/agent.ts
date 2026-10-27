import { Type } from "typebox";
import { ChatError } from "../../../shared/chat.js";
import type { ToolCall } from "./registry.js";
import { None, tool } from "./registry.js";
import type { ToolContext } from "./context.js";

const Name = Type.String({ minLength: 1, maxLength: 80, description: "Unique among all members, people and Bots" });
const BotName = Type.String({ minLength: 1, maxLength: 80, description: "The Bot's name, as bots.list shows it" });
const Model = Type.Object({
  connection: Type.String({ minLength: 1, maxLength: 200, description: "A connection's name or ID from models.list" }),
  model: Type.String({ minLength: 1, maxLength: 200, description: "A model's ID or name in that connection" }),
}, { additionalProperties: false });
const Thinking = Type.Union(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => Type.Literal(level)),
  { description: "How much the model thinks; auto lets this chat platform choose. models.list gives the levels each model has" });
const Settings = {
  description: Type.Optional(Type.String({ maxLength: 1000, description: "One line that other members see in members.list" })),
  persona: Type.Optional(Type.String({ maxLength: 16_000, description: "Its standing instructions: who it is and how it works (the Persona section of its prompt)" })),
  model: Type.Optional(Model), thinking: Type.Optional(Thinking),
};
/** Where a new Bot's file and command tools run by default (A50): its sandbox, which the code calls a computer, or the owner's computer. */
const Environment = Type.Union([Type.Literal("sandbox"), Type.Literal("host")], {
  description: "Where its file and command tools run by default: sandbox, a Linux container that this chat platform makes and only it uses (the default when Docker is available), or host, the owner's computer, where you work too",
});
/** A deletion first asks the owner on a card (A48); the agent words it in the owner's language. */
const Confirm = {
  askIn: Type.String({ description: "ID of a chat the owner is in, where the confirmation card goes; usually the chat you were asked in" }),
  question: Type.String({ minLength: 1, maxLength: 500, description: "The card's question, in the owner's language: what will be deleted and what goes with it" }),
  confirm: Type.String({ minLength: 1, maxLength: 40, description: "Label of the button that deletes, in the owner's language" }),
  cancel: Type.String({ minLength: 1, maxLength: 40, description: "Label of the button that keeps everything, in the owner's language" }),
};
const after = "The owner first gets a card in askIn, and nothing is deleted unless they confirm; the result says what they chose.";

type Confirmation = { askIn: string; question: string; confirm: string; cancel: string };
/** The agent's operations: only the agent Bot has these tools (A48). */
const ops = (context: ToolContext) => context.scope.agent!;
/** A deletion is a step of the tool: the owner's card, then the deletion only if they confirmed; it never rests on the prompt. */
async function confirmed(context: ToolContext, input: Confirmation, call: ToolCall): Promise<{ deleted: false; answer: "cancelled" | "dismissed" } | null> {
  const chat = context.chat(input.askIn);
  if (!chat.memberIds.includes(ops(context).owner)) throw new ChatError(400, "The owner is not in askIn; use a chat they are in, such as your DM with them");
  const answer = await context.ask(chat.id, { question: input.question, multiple: false, allowCustom: false,
    options: [{ label: input.confirm, value: "confirm", style: "danger" }, { label: input.cancel, value: "cancel" }] }, call);
  if (answer.status === "dismissed") return { deleted: false, answer: "dismissed" };
  return answer.selected[0]?.value === "confirm" ? null : { deleted: false, answer: "cancelled" };
}
function channel(context: ToolContext, chatId: string) {
  const chat = context.chat(chatId);
  if (chat.type !== "channel") throw new ChatError(400, "Not a channel");
  return chat;
}

/** The agent Bot's own tools (A48): setting up Bots for the owner, and deletions the owner confirms. Only it lists them;
 * from another Bot they are unknown tools. */
export const agentTools = [
  tool("models.list", "List the models you can give a Bot: each connection with its models and their thinking levels. Only the owner adds connections, keys and logins, in Settings.",
    None, (_args, context) => ops(context).models()),
  tool("bots.create", "Create a Bot. Give it a model so it can work; without one it waits until it gets one. It starts when a message first arrives for it. bots.update changes everything later.",
    Type.Object({ name: Name, ...Settings, environment: Type.Optional(Environment) }, { additionalProperties: false }), async ({ environment, ...settings }, context) => {
    const agent = ops(context);
    const bot = await agent.create({ ...settings, ...(environment ? { environment: environment === "sandbox" ? "computer" as const : "host" as const } : {}) });
    return { name: bot.name, model: bot.connectionId ? agent.modelLabel(bot) : null, thinking: bot.thinkingLevel, environment: agent.environment(bot.id) === "computer" ? "sandbox" : "host" };
  }),
  tool("bots.update", "Change a Bot's name, description, persona, model or thinking; give only what changes. Works for any Bot, yourself included. The Bot is told what changed with its next batch.",
    Type.Object({ bot: BotName, name: Type.Optional(Name), ...Settings }, { additionalProperties: false }), async ({ bot, ...settings }, context) => {
    const result = await ops(context).update(ops(context).bot(bot), settings);
    return { name: result.bot.name, changed: result.changed };
  }),
  tool("bots.start", "Start a stopped Bot. A stopped Bot also starts by itself when a message arrives for it.",
    Type.Object({ bot: BotName }, { additionalProperties: false }), async (input, context) => {
    const bot = ops(context).bot(input.bot);
    return { name: bot.name, status: await ops(context).run(bot, "start") };
  }),
  tool("bots.stop", "Stop a Bot (not yourself): its current turn ends, and it stays stopped until it is started or a message arrives for it.",
    Type.Object({ bot: BotName }, { additionalProperties: false }), async (input, context) => {
    const bot = ops(context).bot(input.bot);
    return { name: bot.name, status: await ops(context).run(bot, "stop") };
  }),
  tool("bots.usage", "A Bot's token use and cost over the last days (7 by default), per model.",
    Type.Object({ bot: BotName, days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })) }, { additionalProperties: false }), (input, context) => {
    const bot = ops(context).bot(input.bot);
    return { name: bot.name, ...ops(context).usage(bot, input.days ?? 7) };
  }),
  tool("bots.delete", `Delete a Bot (not yourself). ${after} Its DMs and channel memberships go; its messages in channels and its workspace stay.`,
    Type.Object({ bot: BotName, ...Confirm }, { additionalProperties: false }), async (input, context, call) => {
    const agent = ops(context), bot = agent.bot(input.bot);
    if (bot.id === agent.agentId) throw new ChatError(400, "You can't delete yourself");
    const declined = await confirmed(context, input, call);
    if (declined) return declined;
    await agent.deleteBot(agent.bot(input.bot));
    return { deleted: true, name: bot.name };
  }),
  tool("chats.delete", `Delete a channel you are in, with its threads, messages and files. ${after}`,
    Type.Object({ chatId: Type.String({ description: "Channel ID" }), ...Confirm }, { additionalProperties: false }), async (input, context, call) => {
    const chat = channel(context, input.chatId);
    const declined = await confirmed(context, input, call);
    if (declined) return declined;
    await ops(context).deleteChannel(chat.id);
    return { deleted: true, name: chat.title };
  }),
  tool("chats.removeMembers", `Remove members from a channel you are in, by name (see members.list). ${after}`,
    Type.Object({ chatId: Type.String({ description: "Channel ID" }), members: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 50 }), ...Confirm }, { additionalProperties: false }), async (input, context, call) => {
    const chat = channel(context, input.chatId);
    const members = context.members(input.members).filter(member => chat.memberIds.includes(member.id));
    if (!members.length) throw new ChatError(400, "None of them is in this channel");
    const declined = await confirmed(context, input, call);
    if (declined) return { removed: [], answer: declined.answer };
    for (const member of members) ops(context).removeMember(chat.id, member.id);
    return { removed: members.map(member => member.name) };
  }),
  tool("sections.delete", `Delete a channel group; its channels stay, outside any group. ${after}`,
    Type.Object({ section: Type.String({ minLength: 1, maxLength: 80, description: "The group's name or ID (see sections.list)" }), ...Confirm }, { additionalProperties: false }), async (input, context, call) => {
    const section = context.section(input.section);
    const declined = await confirmed(context, input, call);
    if (declined) return declined;
    ops(context).deleteSection(section);
    return { deleted: true };
  }),
];
