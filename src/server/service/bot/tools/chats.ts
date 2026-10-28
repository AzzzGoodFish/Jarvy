import { Type } from "typebox";
import { ChatError } from "../../../shared/chat.js";
import { chatDetail, chatRows, threadRow } from "../chat-views.js";
import { botRows } from "../roster.js";
import { None, tool } from "./registry.js";

const Name = (description: string) => Type.String({ minLength: 1, maxLength: 80, description });

/** Members and Bots, chats, channels, threads and channel groups: who is here, and the structure of the conversation. */
export const chatTools = [
  tool("members.list", "List every member, people and Bots: name, kind (user for a person, or bot) and description; self=true is you. Use these names to @-mention someone, add them to a channel or DM them.",
    None, (_args, context) => context.chats.channels.profiles(context.bot).map(member => ({ name: member.name, kind: member.kind,
    ...(member.description ? { description: member.description } : {}), ...(member.id === context.bot ? { self: true } : {}) }))),
  tool("bots.list", "List every Bot and its run state. Read-only; it changes nothing. People and Bots can all see every Bot's name and state; this is not private. For each Bot: name; self=true is you; agent=true is the agent Bot, the owner's helper for running this chat platform: ask it to create or change a Bot, give a Bot a model, see a Bot's usage, or delete a Bot, channel or channel group; status (stop: not running, idle, or running). While it runs, activity is what it is doing (reasoning, texting: writing text, tool_calling, or asking: waiting for a person's answer), chats are the chats it is handling this turn (only those you can read), and otherChats is how many others there are. If its last turn failed, error is the error code. With environments=true, each Bot also has environment: its default work environment, the one it is in now (current) and the ones it may use. You come first, then the rest by name.",
    Type.Object({ environments: Type.Optional(Type.Boolean({ description: "Also give each Bot's work environments" })) }, { additionalProperties: false }), ({ environments }, context) => botRows(context.chats, context.bot, context.scope.roster(),
    environments ? id => context.scope.places.summary(id) : undefined)),
  tool("chats.list", "List the chats you are in: DMs, channels and the threads you follow. Each has its type, title (DMs also give the other member's name in with), channel group (section), topic, your unread count and whether you subscribe; threads also give their channel and status.",
    None, (_args, context) => chatRows(context.chats, context.bot)),
  tool("chats.info", "Details of one chat: members, the channel topic, the full notice or thread summary, your unread count and read position, and whether you subscribe; threads also give their title, status, channel and source message. Reading a notice or summary counts as having seen that version.",
    Type.Object({ chatId: Type.String() }, { additionalProperties: false }), ({ chatId }, context) => chatDetail(context.chats, context.bot, context.chat(chatId))),
  tool("chats.create", "Create a channel. You become a member, and the result has its chatId. members: names of the members to add (see members.list). section: the name of an existing channel group (see sections.list); leave it out for no group.",
    Type.Object({ name: Name("Channel name"), topic: Type.Optional(Type.String({ maxLength: 200 })), section: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      members: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 50 })) }, { additionalProperties: false }), (input, context) => {
    const members = context.members(input.members ?? []);
    const id = context.chats.channels.createChannel(context.bot, { name: input.name, topic: input.topic, sectionId: input.section ? context.section(input.section) : null,
      memberIds: members.map(member => member.id) });
    const chat = context.chat(id);
    return { chatId: id, name: chat.title, members: chat.memberIds.map(memberId => context.chats.member(memberId)?.name) };
  }),
  tool("chats.update", "Change a chat you are in. Channels: name, topic, section (a channel group's name; an empty string takes it out of its group) and notice. Threads: title, status (open or done) and notice (the summary). notice is Markdown and replaces the whole text.",
    Type.Object({ chatId: Type.String(), name: Type.Optional(Name("Channel name")), topic: Type.Optional(Type.String({ maxLength: 200 })), section: Type.Optional(Type.String({ maxLength: 80 })),
      notice: Type.Optional(Type.String({ minLength: 1, maxLength: 20000 })), title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done")])) }, { additionalProperties: false }), (input, context) => {
    const chat = context.chat(input.chatId), chats = context.chats, bot = context.bot;
    const channelChange = input.name !== undefined || input.topic !== undefined || input.section !== undefined;
    const threadChange = input.title !== undefined || input.status !== undefined;
    if (!channelChange && !threadChange && input.notice === undefined) throw new ChatError(400, "Nothing to update");
    if (channelChange && chat.type !== "channel") throw new ChatError(400, "Only channels have a name, topic and section");
    if (threadChange && chat.type !== "thread") throw new ChatError(400, "Only threads have a title and status");
    if (channelChange) chats.channels.updateChannel(bot, chat.id, { name: input.name, topic: input.topic,
      sectionId: input.section === undefined ? undefined : input.section === "" ? null : context.section(input.section) });
    if (threadChange) chats.threads.update(bot, chat.id, { title: input.title, status: input.status });
    const note = input.notice === undefined ? null : chats.channels.setNote(bot, chat.id, input.notice);
    const updated = context.chat(chat.id);
    const section = updated.sectionId ? chats.channels.sections(bot).find(item => item.id === updated.sectionId)?.name : undefined;
    return { chatId: chat.id, title: updated.title, ...(updated.type === "channel" ? { topic: updated.topic, section: section ?? null } : {}),
      ...(updated.type === "thread" ? { status: updated.status } : {}), ...(note ? { noticeVersion: note.version } : {}) };
  }),
  tool("chats.addMembers", "Add members to a channel you are in, by name (see members.list). Only people can remove members from a channel or delete channels and channel groups, and the agent Bot (see bots.list) once the owner confirms.",
    Type.Object({ chatId: Type.String(), members: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }), (input, context) => {
    const chat = context.chat(input.chatId), members = context.members(input.members);
    if (chat.type !== "channel") throw new ChatError(400, "Members are added to channels");
    const added: string[] = [], already: string[] = [];
    for (const member of members) {
      if (chat.memberIds.includes(member.id) || added.includes(member.name)) { already.push(member.name); continue; }
      context.chats.channels.addMember(context.bot, chat.id, member.id);
      added.push(member.name);
    }
    return { chatId: chat.id, added, ...(already.length ? { already } : {}) };
  }),
  tool("chats.subscribe", "Subscribe to a channel or thread, or stop. Normally you only get new messages in channels and threads when you are @-mentioned. While you subscribe, every new message there (with or without an @, whoever it mentions, from a person or a Bot) is sent to you at once and interrupts what you are doing. Subscribe only while you need to follow something live, and stop when you are done; you don't have to reply to every message you get this way. Subscribing to a channel doesn't include its threads; subscribing to a thread also follows it.",
    Type.Object({ chatId: Type.String(), subscribed: Type.Boolean() }, { additionalProperties: false }), (input, context) => {
    const chat = context.chats.subscribe(context.bot, context.chat(input.chatId).id, input.subscribed);
    return { chatId: chat.id, type: chat.type, subscribed: chat.subscribed, ...(chat.type === "thread" ? { following: chat.following } : {}) };
  }),
  tool("threads.list", "List a channel's threads: title, status, reply count, time of the last reply, source message, and whether you follow or subscribe. status is open by default; done and all also work.",
    Type.Object({ chatId: Type.String({ description: "Channel ID" }), status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("done"), Type.Literal("all")])) }, { additionalProperties: false }), (input, context) => {
    const status = input.status ?? "open";
    if (context.chat(input.chatId).type !== "channel") throw new ChatError(400, "Threads belong to channels");
    return context.chats.threads.list(context.bot, input.chatId).filter(entry => status === "all" || entry.chat.status === status)
      .map(entry => threadRow(context.chats, entry));
  }),
  tool("threads.follow", "Follow or unfollow a thread. Followed threads appear in chats.list, and their new replies count as unread for you without interrupting you (use chats.subscribe to get them live). Posting in a thread or being @-mentioned in it follows it for you.",
    Type.Object({ chatId: Type.String({ description: "Thread ID" }), following: Type.Boolean() }, { additionalProperties: false }), (input, context) => {
    const chat = context.chats.threads.setFollowing(context.bot, input.chatId, input.following);
    return { chatId: chat.id, following: chat.following };
  }),
  tool("sections.list", "List the channel groups (sections) with their IDs and names.",
    None, (_args, context) => context.chats.channels.sections(context.bot).map(section => ({ id: section.id, name: section.name }))),
  tool("sections.create", "Create a channel group.",
    Type.Object({ name: Name("Group name") }, { additionalProperties: false }), (input, context) => {
    const section = context.chats.channels.createSection(context.bot, { name: input.name });
    return { id: section.id, name: section.name };
  }),
  tool("sections.update", "Rename a channel group. section: its current name or ID.",
    Type.Object({ section: Type.String({ minLength: 1, maxLength: 80 }), name: Name("New name") }, { additionalProperties: false }), (input, context) => {
    const section = context.chats.channels.updateSection(context.bot, context.section(input.section), { name: input.name });
    return { id: section.id, name: section.name };
  }),
];
