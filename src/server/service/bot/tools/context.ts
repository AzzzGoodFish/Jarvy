import { ChatError, type Chat } from "../../../shared/chat.js";
import type { EnterAsk, Member, QuestionSpec } from "../../../../contract/chat.js";
import type { EnvironmentRecord } from "../../../shared/environment.js";
import type { ChatService } from "../../chat/service.js";
import type { ChatFiles } from "../../chat/files.js";
import type { TaskService } from "../../tasks.js";
import type { PublishedPorts } from "../ports.js";
import type { OutgoingMessage, SentMessage, Memory, Workspace } from "../contracts.js";
import type { RosterEntry } from "../roster.js";
import type { AgentOps } from "../agent.js";
import type { ToolCall } from "./registry.js";

/** The Bot's work environments (A50), for environments.list and environments.switch, and any Bot's for bots.list;
 * environments.request asks the owner for an SSH machine (A57) on a card, by its address or, for one of the owner's,
 * its id, and finds it once added. */
export interface Places { list(): unknown; switch(id: string): Promise<unknown>; summary(botId: string): unknown;
  /** The agent Bot's (A93): an environment its owner has to allow first, by what to call it; and their answer. */
  waiting?(id: string): { label: string; enter: Omit<EnterAsk, "purpose"> } | null; allow?(id: string, once: boolean): void;
  request(input: MachineRequest): Promise<{ granted: EnvironmentRecord } | { question: QuestionSpec }>; found(input: MachineRequest): EnvironmentRecord | null;
  address(id: string): { host: string; user: string; port: number } | null }
export type MachineRequest = { host: string; user: string; port?: number; directory?: string; name?: string; purpose: string };
/** What the tools of one Bot work with. `agent`: the agent Bot's operations (A48); other Bots have none. */
export interface ToolScope {
  botId: string; chats: ChatService; files: ChatFiles; memory: Memory; workspace: Workspace; places: Places;
  /** The secrets this Bot may use (A52), never their values, and the card that asks the owner for one. */
  secrets: { list(): unknown; prepare(name: string, purpose: string): { granted: true } | { question: QuestionSpec } };
  /** Scheduled tasks (A58): the Bot manages its own. */
  tasks: TaskService;
  /** Ports published from sandboxes (A74): the Bot publishes its own. */
  ports: PublishedPorts;
  asking?: (waiting: boolean) => void; roster: () => RosterEntry[]; agent?: AgentOps;
}
type Send = (chatId: string, message: OutgoingMessage) => Promise<SentMessage>;
/** A chat as the agent's log names it: a channel or thread by title, a DM by who is in it. */
export function chatLabel(chats: ChatService, chat: Chat): string {
  if (chat.type !== "dm") return `${chat.type === "thread" ? "thread" : "#"}${chat.type === "thread" ? ` 「${chat.title}」` : chat.title}`;
  return `DM ${chat.memberIds.map(id => chats.member(id)?.name ?? id).join(" · ")}`;
}
const same = (a: string, b: string) => a.trim().replace(/^@/, "").toLocaleLowerCase() === b.toLocaleLowerCase();

/** What every tool may use: the Bot's scope, and what several tools share — finding a chat, member or channel group by
 * what the Bot wrote, sending, asking on a card, and telling it what it hadn't read. */
export class ToolContext {
  constructor(readonly scope: ToolScope, private readonly sender: () => Send | undefined) {}
  get bot() { return this.scope.botId; }
  get chats() { return this.scope.chats; }

  chat(chatId: string): Chat {
    const chat = this.chats.get(this.bot, chatId);
    if (!chat) throw new ChatError(404, "Chat not found");
    return chat;
  }
  /** Whether the Bot is in the chat (a thread's channel for a thread). The agent Bot can read every chat of its
   * owner's without being in it (A93), so a tool that writes asks this first. */
  isMember(chat: Chat): boolean { return chat.memberIds.includes(this.bot); }
  /** The agent Bot looking into a chat it isn't in is logged for its owner (A93); nothing for any other read. */
  oversee(chat: Chat, tool: string, detail = ""): void {
    if (this.scope.agent && !this.isMember(chat)) this.scope.agent.log({ tool, target: chatLabel(this.chats, chat), detail, outcome: "done" });
  }
  /** Members by name (case-insensitive, a leading @ allowed); unknown names are an error that lists them. */
  members(names: readonly string[]): Member[] {
    const directory = this.chats.channels.directory(this.bot);
    const found = names.map(name => ({ name, member: directory.find(member => same(name, member.name)) }));
    const missing = found.filter(item => !item.member).map(item => item.name);
    if (missing.length) throw new ChatError(404, `No member named: ${missing.join(", ")} (see members.list)`);
    return found.map(item => item.member!);
  }
  /** A channel group by ID or name. */
  section(value: string): string {
    const sections = this.chats.channels.sections(this.bot);
    const matches = sections.filter(section => section.id === value || same(value, section.name));
    if (!matches.length) throw new ChatError(404, `No section named ${value} (see sections.list)`);
    if (matches.length > 1) throw new ChatError(409, `Several sections are named ${value}; use one of: ${matches.map(section => section.id).join(", ")}`);
    return matches[0]!.id;
  }
  /** Only people answer cards; in a chat of Bots alone a card would wait forever. */
  withPerson(chatId: string, otherwise: string): Chat {
    const chat = this.chat(chatId);
    if (!chat.memberIds.some(id => this.chats.member(id)?.kind === "user")) throw new ChatError(400, `No person in this chat to answer; ${otherwise}`);
    return chat;
  }
  send(chatId: string, message: OutgoingMessage): Promise<SentMessage> { this.unreadNote(chatId); return this.sender()!(chatId, message); }
  /** A Bot sends only where it has read what the place is for (A67): its notice, or its thread's summary and the
   * channel's notice. Being told of a new version is not reading it. A DM has no notice. */
  unreadNote(chatId: string): void {
    const chat = this.chats.get(this.bot, chatId);
    if (!chat) return;
    if (!this.isMember(chat)) throw new ChatError(403, chat.type === "dm" ? "You can read this DM but not write in it: it is between others."
      : `You can read this ${chat.type} but you aren't in ${chat.type === "thread" ? "its channel" : "it"}. Join the channel with chats.join first, if this is yours to take part in; the channel's notice still says who should.`);
    if (chat.type === "dm") return;
    const missing = this.chats.channels.unreadNotes(this.bot, [chatId]);
    if (!missing.length) return;
    const name = (note: { title: string; type: string; version: number }) => note.type === "thread"
      ? `this thread's summary (version ${note.version})` : `the notice of 「${note.title}」 (${note.type}, version ${note.version})`;
    const ids = missing.map(note => `chatId: "${note.chatId}"`).join(", ");
    throw new ChatError(409, `Unread notice: you haven't read ${missing.map(name).join(" or ")} yet. Read ${missing.length === 1 ? "it" : "them"} with chats.info (${ids}), `
      + `make sure your message follows ${missing.length === 1 ? "it" : "them"}, then send again.`);
  }
  /** Posts a card and waits for the person's answer (messages.ask, the requests for a secret or a machine, the agent's confirmations). */
  async ask(chatId: string, question: QuestionSpec, call: ToolCall) {
    const sent = await this.send(chatId, { content: question.question, question, toolCallId: call.toolCallId, signal: call.signal });
    this.scope.asking?.(true);
    try { return { messageId: sent.id, ...await this.chats.questions.wait(this.chats.message(this.bot, sent.id)!, call.signal) }; }
    finally { if (!call.signal?.aborted) this.scope.asking?.(false); }
  }
  /** Where the Bot had read up to in a chat, and how many messages it hadn't, before it writes there (A53). Sending
   * moves its read position past them, so this is taken first. A thread counts only itself. */
  readState(chatId: string) {
    const chat = this.chats.get(this.bot, chatId);
    return { unread: chat?.unread ?? 0, after: chat?.readSequence ?? 0 };
  }
  /** Others' messages it hadn't read (delivered ones arrive in its batches anyway), and where to read them from. */
  unreadHint(count: number, after: number) {
    const one = count === 1;
    return count ? { unread: count, note: `${count} message${one ? "" : "s"} here you hadn't read. Read ${one ? "it" : "them"} with messages.read `
      + `(chatId, after=${after}), which may also bring back messages you already have, and follow up if ${one ? "it changes" : "they change"} where things stand.` } : {};
  }
}
