import { Type } from "typebox";
import { ChatError, type Chat, type ChatMessage } from "../../../shared/chat.js";
import type { QuestionSpec } from "../../../../contract/chat.js";
import { listing } from "../../chat/files.js";
import { messageRow } from "../chat-views.js";
import type { ToolContext } from "./context.js";
import { MessageId, tool } from "./registry.js";

const QuestionOption = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80, description: "Text shown on the option" }),
  value: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "What you get back when it is picked, written as the person would naturally say it; label by default" })),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "A note under the option" })),
  style: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("primary"), Type.Literal("danger")])),
}, { additionalProperties: false });

async function rows(context: ToolContext, messages: readonly ChatMessage[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  return messages.map(message => messageRow(context.chats, context.bot, message, listing(message)));
}
/** One page of a sequential read; the read position moves to its last message. */
async function page(context: ToolContext, chatId: string, messages: ChatMessage[], limit: number, signal?: AbortSignal) {
  const shown = messages.slice(0, limit);
  if (shown.length) context.chats.channels.markRead(context.bot, chatId, shown.at(-1)!.sequence);
  return { messages: await rows(context, shown, signal), ...(messages.length > limit ? { hasMore: true } : {}) };
}

/** Reading, searching, sending, asking and reacting. What reaches the chat goes through the runtime's send (A53). */
export const messageTools = [
  tool("messages.read", "Read messages; their files are listed by id, name, type and size, for files.get and files.view. Three ways: ① chatId + after: read on from that sequence number (from the start by default); ② around with a message ID: that message and context messages on each side (5 by default), to see the context; this doesn't move your read position; ③ unread=true: your unread messages, in one chat with chatId, or in every chat (grouped by chat) without it. ① and ③ move your read position to the last message read; hasMore=true means there is more, so call again.",
    Type.Object({ chatId: Type.Optional(Type.String()), after: Type.Optional(Type.Integer({ minimum: 0 })), around: Type.Optional(MessageId),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })), unread: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }), async (input, context, { signal }) => {
    const chats = context.chats, bot = context.bot;
    const limit = input.limit ?? 30, modes = [input.after !== undefined, input.around !== undefined, input.unread === true].filter(Boolean).length;
    if (modes > 1) throw new ChatError(400, "Use one of after, around or unread");
    if (input.around !== undefined) {
      const messages = chats.around(bot, input.around, input.context ?? 5);
      if (input.chatId !== undefined && messages[0]?.chatId !== input.chatId) throw new ChatError(404, "Message not found in this chat");
      return { chatId: messages[0]!.chatId, messages: await rows(context, messages, signal) };
    }
    if (input.unread && input.chatId === undefined) {
      const found = [];
      for (const chat of [...chats.list(bot), ...chats.threads.followed(bot).map(entry => entry.chat)].filter(item => item.unread > 0))
        found.push({ chatId: chat.id, type: chat.type, title: chat.title, ...await page(context, chat.id, chats.unreadMessages(bot, chat.id, limit + 1), limit, signal) });
      return { chats: found };
    }
    if (input.chatId === undefined) throw new ChatError(400, "chatId is required unless unread=true");
    const chat = context.chat(input.chatId);
    const messages = input.unread ? chats.unreadMessages(bot, chat.id, limit + 1) : chats.read(bot, chat.id, input.after ?? 0, limit + 1);
    return { chatId: chat.id, ...await page(context, chat.id, messages, limit, signal) };
  }),
  // `mine`: only what this Bot sent; those messages carry the History ID of the turn that sent them (A21).
  tool("messages.search", "Search message text. With chatId, only that chat; without it, every chat you can see, and each result says which chat it is in. Results list their files like messages.read. mine=true: only messages you sent; each carries the History ID of the turn that sent it.",
    Type.Object({ chatId: Type.Optional(Type.String()), query: Type.String({ minLength: 1, maxLength: 500 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      mine: Type.Optional(Type.Boolean({ description: "Only messages you sent" })) }, { additionalProperties: false }), (input, context) => {
    const chats = context.chats, bot = context.bot, sender = input.mine ? bot : undefined;
    const found = input.chatId === undefined ? chats.searchAll(bot, input.query, input.limit ?? 30, undefined, sender)
      : chats.search(bot, context.chat(input.chatId).id, input.query, input.limit ?? 30, sender);
    const places = new Map<string, Chat | null>();
    const chatOf = (id: string) => { if (!places.has(id)) places.set(id, chats.get(bot, id)); return places.get(id); };
    return found.map(message => messageRow(chats, bot, message, listing(message), input.chatId === undefined ? chatOf(message.chatId) : null));
  }),
  tool("messages.send", "Send a message, with files from your environment if you like (path there, absolute or relative to your directory, and the name people see). Give chatId or to, not both: to is a member's name and sends them a DM (a person or a Bot; the first time creates the DM). Only messages sent successfully are visible in the chat. In channels and threads, only the members whose @name is in the text and the members subscribed there receive it; DMs need no @. The result lists who was @-mentioned (notified), who got it through a subscription (subscribers), and the names that aren't in the channel and weren't told. If the chat had messages you hadn't read, it also gives their count (unread) and a note on where to read them: sending marks them read, so read from the after it names. thread: the ID of a message in the channel, to reply in that message's thread (created if it has none; chatId is the channel). replyTo: the ID of a message in the same chat, to reply to it as a quote; this tells its author, like an @. When replying in a thread, alsoToChannel=true also posts a copy to the channel.",
    Type.Object({ chatId: Type.Optional(Type.String()), to: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), message: Type.String({ maxLength: 32000 }),
      thread: Type.Optional(MessageId), replyTo: Type.Optional(MessageId), alsoToChannel: Type.Optional(Type.Boolean()),
      attachments: Type.Optional(Type.Array(Type.Object({ path: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }), { maxItems: 5 })) }, { additionalProperties: false }), async (input, context, { toolCallId, signal }) => {
    const chats = context.chats, bot = context.bot;
    if ((input.chatId === undefined) === (input.to === undefined)) throw new ChatError(400, "Give either chatId or to");
    if (input.to !== undefined && (input.thread || input.alsoToChannel)) throw new ChatError(400, "thread and alsoToChannel need a channel chatId");
    if (input.replyTo !== undefined && !chats.message(bot, input.replyTo)) throw new ChatError(404, "Reply target not found");
    let chatId = input.to !== undefined ? chats.openDirect(bot, context.members([input.to])[0]!.id).id : context.chat(input.chatId!).id;
    if (input.thread) {
      const root = chats.message(bot, input.thread);
      if (!root || root.chatId !== chatId) throw new ChatError(404, "Message not found in this channel");
      chatId = chats.threads.open(bot, input.thread).id;
    }
    const before = context.readState(chatId);
    const sent = await context.send(chatId, { content: input.message, attachments: input.attachments, ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.alsoToChannel ? { alsoToChannel: true } : {}), toolCallId, signal });
    const chat = chats.get(bot, chatId);
    if (!chat || chat.type === "dm") return { messageId: sent.id, chatId: sent.chatId, sequence: sent.sequence, ...context.unreadHint(before.unread, before.after) };
    const report = chats.channels.mentionReport(bot, chatId, input.message);
    // Saved mentions include the author of a replied-to message, not only the @ in the text.
    const notified = sent.mentions.map(id => chats.member(id)?.name).filter((name): name is string => !!name);
    const subscribers = chats.channels.subscribers(bot, chatId).map(member => member.name)
      .filter(name => name !== chats.member(bot)?.name && !notified.includes(name));
    return { messageId: sent.id, chatId: sent.chatId, sequence: sent.sequence, notified,
      ...(subscribers.length ? { subscribers } : {}), ...(report.notInChannel.length ? { notInChannel: report.notInChannel } : {}), ...context.unreadHint(before.unread, before.after) };
  }),
  tool("messages.ask", "Post a multiple-choice card in a chat you are in and wait for the person's answer. It returns {status:\"answered\", selected:[{label,value}], custom}, or {status:\"dismissed\"} if they closed the question without answering. If the chat had messages you hadn't read, before the card or while it waited, it also gives their count (unread) and a note on where to read them. Use it when someone needs to choose or confirm (a plan, a preference, whether to go on with something risky); ask open questions with messages.send. options: 1–6; multiple allows several choices; allowCustom lets them write their own answer (custom). If, while you wait, the person sends a new message, cancels this turn or stops the Bot, the call is interrupted and the new message arrives in the next batch. Only people can answer, so it can't be used in chats without one (such as a DM between Bots). Never use it to ask for passwords, tokens or keys: use secrets.request.",
    Type.Object({ chatId: Type.String(), question: Type.String({ minLength: 1, maxLength: 500 }), detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      options: Type.Array(QuestionOption, { minItems: 1, maxItems: 6 }), multiple: Type.Optional(Type.Boolean()), allowCustom: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), async (input, context, call) => {
    const chatId = context.withPerson(input.chatId, "use messages.send").id;
    const question: QuestionSpec = { question: input.question, ...(input.detail ? { detail: input.detail } : {}), options: input.options,
      multiple: input.multiple === true, allowCustom: input.allowCustom === true };
    // Unread before the card, plus what came in while it waited.
    const before = context.readState(chatId);
    const answer = await context.ask(chatId, question, call);
    return { ...answer, ...context.unreadHint(before.unread + context.readState(chatId).unread, before.after) };
  }),
  tool("messages.react", "Add or remove an emoji reaction on a message (people and Bots can both react). on=false removes it. Giving an emoji the message already has from you removes it instead (and the other way round); marked or unmarked and note in the result say which happened. Use this toggle to signal states such as \"got it\", \"on it\" and \"done\". Only the message's author is told: if they are running, it joins their current turn without interrupting; if they are idle, it starts a turn.",
    Type.Object({ messageId: MessageId, emoji: Type.String({ minLength: 1, maxLength: 32, description: "A single emoji, such as 👍" }), on: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), (input, context) => {
    const wanted = input.on !== false, had = context.chats.reactionOn(context.bot, input.messageId, input.emoji);
    const message = context.chats.react(context.bot, input.messageId, input.emoji, wanted);
    const applied = wanted === had ? !wanted : wanted;
    return { messageId: message.id, emoji: input.emoji, [applied ? "marked" : "unmarked"]: true,
      note: applied ? "Reaction added" : "You already had this reaction, so this removed it",
      reactions: message.reactions.map(group => ({ emoji: group.emoji, count: group.memberIds.length })) };
  }),
];
