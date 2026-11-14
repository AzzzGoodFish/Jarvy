import { Type, type Static, type TSchema } from "typebox";
import { ChatError } from "../../../shared/chat.js";
import type { BotTool, ToolCall } from "./registry.js";
import { None, tool } from "./registry.js";
import { chatLabel, type ToolContext } from "./context.js";

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
/** A channel the agent is in: it reads every chat of its owner's (A93), but deletes and removes only where it is. */
function channel(context: ToolContext, chatId: string) {
  const chat = context.chat(chatId);
  if (chat.type !== "channel") throw new ChatError(400, "Not a channel");
  if (!context.isMember(chat)) throw new ChatError(403, "You aren't in this channel");
  return chat;
}
/** How a call went, for the log: a card's answer, else done. */
function outcome(result: unknown): string {
  const answer = typeof result === "object" && result !== null ? (result as { answer?: unknown }).answer : undefined;
  return answer === "cancelled" ? "declined" : typeof answer === "string" ? answer : "done";
}
/** A tool whose every use is logged for the owner (A93): what it acted on and how it went, failures included. */
function logged<S extends TSchema>(name: string, description: string, schema: S, target: (input: Static<S>, context: ToolContext) => string,
  run: (input: Static<S>, context: ToolContext, call: ToolCall) => unknown, detail?: (input: Static<S>) => string): BotTool {
  return tool(name, description, schema, async (input, context, call) => {
    let what = "";
    try { what = target(input, context); } catch { what = JSON.stringify(input).slice(0, 200); }
    try {
      const result = await run(input, context, call);
      ops(context).log({ tool: name, target: what, detail: detail?.(input) ?? "", outcome: outcome(result) });
      return result;
    } catch (error) {
      ops(context).log({ tool: name, target: what, detail: error instanceof Error ? error.message : String(error), outcome: "failed" });
      throw error;
    }
  });
}
const named = (input: { bot?: string; name?: string }) => input.bot ?? input.name ?? "";

/** The agent Bot's own tools (A48): setting up Bots for the owner, and deletions the owner confirms. Only it lists them;
 * from another Bot they are unknown tools. */
export const agentTools = [
  tool("skills.read", "Read one of the skills your prompt lists: its whole guide. Works wherever you work, also when your file tools can't.",
    Type.Object({ name: Type.String({ minLength: 1, maxLength: 80, description: "The skill's name, as your prompt lists it" }) }, { additionalProperties: false }),
    (input, context) => ops(context).skill(input.name)),
  tool("models.list", "List the models you can give a Bot: each connection with its models and their thinking levels. Only the owner adds connections, keys and logins, in Settings.",
    None, (_args, context) => ops(context).models()),
  logged("bots.create", "Create a Bot. Give it a model so it can work; without one it waits until it gets one. It starts when a message first arrives for it. bots.update changes everything later.",
    Type.Object({ name: Name, ...Settings }, { additionalProperties: false }), named, async (settings, context) => {
    const agent = ops(context);
    const bot = await agent.create(settings);
    return { name: bot.name, model: bot.connectionId ? agent.modelLabel(bot) : null, thinking: bot.thinkingLevel, environment: agent.environment(bot.id) };
  }),
  logged("bots.update", "Change a Bot's name, description, persona, model or thinking; give only what changes. Works for any Bot, yourself included. The Bot is told what changed with its next batch.",
    Type.Object({ bot: BotName, name: Type.Optional(Name), ...Settings }, { additionalProperties: false }), named, async ({ bot, ...settings }, context) => {
    const result = await ops(context).update(ops(context).bot(bot), settings);
    return { name: result.bot.name, changed: result.changed };
  }, input => Object.keys(input).filter(key => key !== "bot").join(", ")),
  logged("bots.start", "Start a stopped Bot. A stopped Bot also starts by itself when a message arrives for it.",
    Type.Object({ bot: BotName }, { additionalProperties: false }), named, async (input, context) => {
    const bot = ops(context).bot(input.bot);
    return { name: bot.name, status: await ops(context).run(bot, "start") };
  }),
  logged("bots.stop", "Stop a Bot (not yourself): its current turn ends, and it stays stopped until it is started or a message arrives for it.",
    Type.Object({ bot: BotName }, { additionalProperties: false }), named, async (input, context) => {
    const bot = ops(context).bot(input.bot);
    return { name: bot.name, status: await ops(context).run(bot, "stop") };
  }),
  tool("bots.usage", "A Bot's token use and cost over the last days (7 by default), per model.",
    Type.Object({ bot: BotName, days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })) }, { additionalProperties: false }), (input, context) => {
    const bot = ops(context).bot(input.bot);
    return { name: bot.name, ...ops(context).usage(bot, input.days ?? 7) };
  }),
  logged("bots.delete", `Delete a Bot (not yourself). ${after} Its DMs and channel memberships go; its messages in channels and its workspace stay.`,
    Type.Object({ bot: BotName, ...Confirm }, { additionalProperties: false }), named, async (input, context, call) => {
    const agent = ops(context), bot = agent.bot(input.bot);
    if (bot.id === agent.agentId) throw new ChatError(400, "You can't delete yourself");
    const declined = await confirmed(context, input, call);
    if (declined) return declined;
    await agent.deleteBot(agent.bot(input.bot));
    return { deleted: true, name: bot.name };
  }),
  logged("chats.delete", `Delete a channel you are in, with its threads, messages and files. ${after}`,
    Type.Object({ chatId: Type.String({ description: "Channel ID" }), ...Confirm }, { additionalProperties: false }), (input, context) => chatLabel(context.chats, context.chat(input.chatId)), async (input, context, call) => {
    const chat = channel(context, input.chatId);
    const declined = await confirmed(context, input, call);
    if (declined) return declined;
    await ops(context).deleteChannel(chat.id);
    return { deleted: true, name: chat.title };
  }),
  logged("chats.removeMembers", `Remove members from a channel you are in, by name (see members.list). ${after}`,
    Type.Object({ chatId: Type.String({ description: "Channel ID" }), members: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 50 }), ...Confirm }, { additionalProperties: false }), (input, context) => chatLabel(context.chats, context.chat(input.chatId)), async (input, context, call) => {
    const chat = channel(context, input.chatId);
    const members = context.members(input.members).filter(member => chat.memberIds.includes(member.id));
    if (!members.length) throw new ChatError(400, "None of them is in this channel");
    const declined = await confirmed(context, input, call);
    if (declined) return { removed: [], answer: declined.answer };
    for (const member of members) ops(context).removeMember(chat.id, member.id);
    return { removed: members.map(member => member.name) };
  }),
  logged("sections.delete", `Delete a channel group; its channels stay, outside any group. ${after}`,
    Type.Object({ section: Type.String({ minLength: 1, maxLength: 80, description: "The group's name or ID (see sections.list)" }), ...Confirm }, { additionalProperties: false }), input => input.section, async (input, context, call) => {
    const section = context.section(input.section);
    const declined = await confirmed(context, input, call);
    if (declined) return declined;
    ops(context).deleteSection(section);
    return { deleted: true };
  }),
  // Oversight (A93): every chat to read, and other Bots' sandboxes and activity, each use logged for the owner.
  logged("chats.browse", "List every channel and DM of your owner's, whether or not you are in it, the most recently active first: type, title (a DM's members in with), topic, member (whether you are in it) and when it was last active. You can read any of them with chats.info, messages.read, messages.search and threads.list, but you write, react and subscribe only where you are a member: join a channel with chats.join. Looking into a chat you aren't in is logged for your owner.",
    None, () => "all chats", (_args, context) => ops(context).everyChat().map(chat => ({ chatId: chat.id, type: chat.type, title: chat.title,
      ...(chat.type === "dm" ? { with: chat.memberIds.map(id => context.chats.member(id)?.name ?? id) } : {}), ...(chat.topic ? { topic: chat.topic } : {}),
      member: context.isMember(chat), lastActive: new Date(chat.updatedAt).toISOString() }))),
  logged("chats.join", "Join a channel you aren't in, so you can write there. Join only where taking part is yours to do: read its notice first with chats.info (its rules apply to you as to everyone), and give a short first message saying why you joined; it is posted as your first message there. Seeing a channel doesn't mean stepping in.",
    Type.Object({ chatId: Type.String({ description: "Channel ID" }), message: Type.String({ minLength: 1, maxLength: 2000, description: "Your first message there: why you joined, in the channel's language" }) }, { additionalProperties: false }),
    (input, context) => chatLabel(context.chats, context.chat(input.chatId)), async (input, context, call) => {
    const chat = context.chat(input.chatId);
    if (chat.type !== "channel") throw new ChatError(400, "Only channels can be joined; a thread is its channel's, and a DM is between its two members");
    if (context.isMember(chat)) throw new ChatError(409, "You are already in this channel");
    const unread = context.chats.channels.unreadNotes(context.bot, [chat.id]);
    if (unread.length) throw new ChatError(409, `Read the channel's notice first with chats.info (chatId: "${chat.id}"), then join if it is yours to take part in`);
    ops(context).join(chat.id);
    // What was said before it joined isn't unread for it.
    context.chats.channels.markRead(context.bot, chat.id, Number.MAX_SAFE_INTEGER);
    const sent = await context.send(chat.id, { content: input.message, toolCallId: call.toolCallId, signal: call.signal });
    return { chatId: chat.id, joined: true, messageId: sent.id };
  }),
  logged("environments.enter", "Move your file and command tools into another Bot's sandbox, or an SSH machine of your owner's you may not use yet (granted=false in environments.list), once your owner allows it on a card. They can allow it until they revoke it, only for this run, or decline. Another Bot's sandbox is its workspace: do there only what the task needs, and tell its Bot what you changed. Once allowed, it works like environments.switch, and environments.switch with your own sandbox's id brings you back.",
    Type.Object({ id: Type.String({ minLength: 1, maxLength: 80, description: "The environment's id from environments.list" }),
      askIn: Type.String({ description: "ID of a chat the owner is in, where the card goes; usually the chat you were asked in" }),
      purpose: Type.String({ minLength: 1, maxLength: 300, description: "Why you need to work there, in your owner's language; shown on the card" }) }, { additionalProperties: false }),
    (input, context) => {
      const waiting = context.scope.places.waiting?.(input.id);
      if (waiting) return waiting.label;
      const listed = (context.scope.places.list() as { environments?: { id: string; name: string; bot?: string }[] }).environments?.find(e => e.id === input.id);
      return listed?.bot ? `${listed.bot}'s sandbox` : listed?.name ?? input.id;
    }, async (input, context, call) => {
    const places = context.scope.places, waiting = places.waiting?.(input.id);
    if (!waiting) return { ...await places.switch(input.id) as object, note: "You may already work here; no card was needed." };
    const chat = context.chat(input.askIn);
    if (!chat.memberIds.includes(ops(context).owner)) throw new ChatError(400, "The owner is not in askIn; use a chat they are in, such as your DM with them");
    const purpose = input.purpose.trim();
    const answer = await context.ask(chat.id, { question: purpose, multiple: false, allowCustom: false,
      options: [{ label: "Keep allowing", value: "always" }, { label: "This time only", value: "once" }],
      enter: { ...waiting.enter, purpose } }, call);
    if (answer.status === "dismissed") return { switched: false, answer: "declined" };
    const once = answer.selected[0]?.value === "once";
    places.allow!(input.id, once);
    return { ...await places.switch(input.id) as object, answer: once ? "allowed once" : "allowed" };
  }),
  logged("bots.activity", "Read another Bot's History, as your owner sees it on its activity page: without ids, a page of summaries, newest first (each record's id, time, role, the start of its text and its tool steps); with ids, those records in full. before: a page's nextBefore, for the page after it.",
    Type.Object({ bot: BotName, ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 20 })),
      before: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    named, (input, context) => {
    const bot = ops(context).bot(input.bot);
    if (bot.id === ops(context).agentId) throw new ChatError(400, "That's you: read your own History with history.read");
    return { name: bot.name, ...ops(context).activity(bot, input) };
  }, input => input.ids ? input.ids.map(id => `#${id}`).join(" ") : ""),
];
