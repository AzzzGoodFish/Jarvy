import type { ToolDefinition } from "../../shared/tools.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ChatError } from "../../shared/chat.js";
import { type QuestionSpec } from "../../../contract/chat.js";
import type { ChatService } from "../chat/service.js";
import type { ChatFiles } from "../chat/files.js";
import type { Tools as ToolsPort, OutgoingMessage, SentMessage, Memory, Workspace } from "./contracts.js";

import { readHistory, type HistoryReadInput } from "./history-read.js";
import { viewFile } from "./file-view.js";
import { byteSize } from "../chat/files.js";
import { chatDetail, chatRows } from "./chat-views.js";
import { ChatTools } from "./chat-tools.js";
import { definitions, type ToolName } from "./tool-schemas.js";
import { botRows, type RosterEntry } from "./roster.js";
import type { AgentOps } from "./agent.js";
import { AgentTools } from "./agent-tools.js";
import { agentDefinitions, type AgentToolName } from "./agent-schemas.js";
import { placeholder } from "../../shared/secret-mask.js";
import type { EnvironmentRecord } from "../../shared/environment.js";
import { argumentProblems, invalidArguments, unknownTool } from "./tool-errors.js";
import { callTask, taskDefinitions, type TaskToolName } from "./task-tools.js";
import type { TaskService } from "../tasks.js";

/** The Bot's work environments (A50), for environments.list and environments.switch, and any Bot's for bots.list;
 * environments.request asks the owner for an SSH machine (A57) on a card, and finds it once added. */
export interface Places { list(): unknown; switch(id: string): Promise<unknown>; summary(botId: string): unknown;
  request(input: MachineRequest): Promise<{ granted: EnvironmentRecord } | { question: QuestionSpec }>; found(input: MachineRequest): EnvironmentRecord | null }
type MachineRequest = { host: string; user: string; port?: number; directory?: string; name?: string; purpose: string };

const Gateway = Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("describe"), Type.Literal("call")]),
  tool: Type.Optional(Type.String()), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false });
export class Tools implements ToolsPort {
  private send?: (chatId: string, message: OutgoingMessage) => Promise<SentMessage>;
  private readonly tools: ChatTools;
  /** The agent Bot's own tools (A48); other Bots have none. */
  private readonly agent?: AgentTools;
  constructor(private readonly scope: { botId: string; chats: ChatService; files: ChatFiles; memory: Memory; workspace: Workspace; places: Places;
    /** The secrets this Bot may use (A52), never their values, and the card that asks the owner for one. */
    secrets: { list(): unknown; prepare(name: string, purpose: string): { granted: true } | { question: QuestionSpec } };
    /** Scheduled tasks (A58): the Bot manages its own. */
    tasks: TaskService;
    asking?: (waiting: boolean) => void; roster: () => RosterEntry[]; agent?: AgentOps }) {
    this.tools = new ChatTools(scope);
    if (scope.agent) this.agent = new AgentTools({ ops: scope.agent, tools: this.tools });
  }
  private get catalog(): Record<string, { description: string; schema: (typeof definitions)[ToolName]["schema"] | (typeof agentDefinitions)[AgentToolName]["schema"] | (typeof taskDefinitions)[TaskToolName]["schema"] }> {
    return this.agent ? { ...definitions, ...taskDefinitions, ...agentDefinitions } : { ...definitions, ...taskDefinitions };
  }
  /** Posts a card and waits for the person's answer (messages.ask, and the agent's confirmations). */
  private async ask(chatId: string, question: QuestionSpec, toolCallId: string, signal?: AbortSignal) {
    const sent = await this.send!(chatId, { content: question.question, question, toolCallId, signal });
    this.scope.asking?.(true);
    try { return { messageId: sent.id, ...await this.scope.chats.questions.wait(this.scope.chats.message(this.scope.botId, sent.id)!, signal) }; }
    finally { if (!signal?.aborted) this.scope.asking?.(false); }
  }
  /** Where the Bot had read up to in a chat, and how many messages it hadn't, before it writes there (A53). Sending
   * moves its read position past them, so this is taken first. A thread counts only itself. */
  private readState(chatId: string) {
    const chat = this.scope.chats.get(this.scope.botId, chatId);
    return { unread: chat?.unread ?? 0, after: chat?.readSequence ?? 0 };
  }
  /** Others' messages it hadn't read (delivered ones arrive in its batches anyway), and where to read them from. */
  private unreadHint(count: number, after: number) {
    const one = count === 1;
    return count ? { unread: count, note: `${count} message${one ? "" : "s"} here you hadn't read. Read ${one ? "it" : "them"} with messages.read `
      + `(chatId, after=${after}), which may also bring back messages you already have, and follow up if ${one ? "it changes" : "they change"} where things stand.` } : {};
  }
  bindSend(send: (chatId: string, message: OutgoingMessage) => Promise<SentMessage>) { this.send = send; }
  definitions(): readonly ToolDefinition[] {
    return [{
      name: "chat",
      description: "Gateway to the chat and to your own History. Use list to see the tools, describe to check a tool's parameters, then call to run it. Only what messages.send or messages.ask sends successfully is visible in the chat.",
      parameters: Gateway,
      execute: async (raw, { toolCallId, signal }) => {
        if (!Value.Check(Gateway, raw)) throw new ChatError(400, ["Invalid chat tool request:", ...argumentProblems(Gateway, raw).map(line => `- ${line}`),
          'It takes {action: "list" | "describe" | "call", tool, args}: list takes neither, describe takes tool, call takes both.'].join("\n"));
        signal?.throwIfAborted();
        if (raw.action === "list") {
          if (raw.tool !== undefined || raw.args !== undefined) throw new ChatError(400, "list does not accept tool or args");
          return Object.entries(this.catalog).map(([name, tool]) => ({ name, description: tool.description }));
        }
        if (!raw.tool || !Object.hasOwn(this.catalog, raw.tool)) throw new ChatError(400, unknownTool(raw.tool, Object.keys(this.catalog)));
        const name = raw.tool as ToolName, definition = this.catalog[name]!;
        if (raw.action === "describe") {
          if (raw.args !== undefined) throw new ChatError(400, "describe does not accept args");
          return { name, description: definition.description, parameters: definition.schema };
        }
        const args = raw.args;
        if (!args || !Value.Check(definition.schema, args)) throw new ChatError(400, invalidArguments(name, definition.schema, args));
        if (this.agent && Object.hasOwn(agentDefinitions, name))
          return this.agent.call(name as unknown as AgentToolName, args, (chatId, question) => this.ask(chatId, question, toolCallId, signal));
        if (Object.hasOwn(taskDefinitions, name)) return callTask(this.scope.tasks, this.scope.botId, name as unknown as TaskToolName, args);
        switch (name) {
          case "history.read":
            return readHistory(this.scope.memory, this.scope.workspace, args as HistoryReadInput, signal);
          case "chats.list":
            return chatRows(this.scope.chats, this.scope.botId);
          case "chats.info":
            return chatDetail(this.scope.chats, this.scope.botId, this.tools.chat((args as { chatId: string }).chatId));
          case "members.list": return this.tools.membersList();
          case "bots.list": return botRows(this.scope.chats, this.scope.botId, this.scope.roster(),
            (args as { environments?: boolean }).environments ? id => this.scope.places.summary(id) : undefined);
          case "environments.list": return this.scope.places.list();
          case "environments.switch": return this.scope.places.switch((args as { id: string }).id);
          case "secrets.list": return this.scope.secrets.list();
          case "secrets.request": {
            const parsed = args as { chatId: string; name: string; purpose: string };
            if (!this.tools.chat(parsed.chatId).memberIds.some(id => this.scope.chats.member(id)?.kind === "user")) throw new ChatError(400, "No person in this chat to answer; ask in a chat with your owner");
            const prepared = this.scope.secrets.prepare(parsed.name, parsed.purpose.trim());
            if ("granted" in prepared) return { status: "granted", name: parsed.name, placeholder: placeholder(parsed.name), note: "You may already use it" };
            const result = await this.ask(parsed.chatId, prepared.question, toolCallId, signal);
            if (result.status !== "answered") return { messageId: result.messageId, status: "declined", note: "Your owner declined. Don't ask for the value in the chat; go on without it, or ask what they would like instead." };
            return { messageId: result.messageId, status: "granted", name: parsed.name, placeholder: placeholder(parsed.name),
              until: result.selected[0]?.value === "once" ? "this run ends" : "your owner revokes it" };
          }
          case "environments.request": {
            const parsed = args as MachineRequest & { chatId: string };
            if (!this.tools.chat(parsed.chatId).memberIds.some(id => this.scope.chats.member(id)?.kind === "user")) throw new ChatError(400, "No person in this chat to answer; ask in a chat with your owner");
            const input = { ...parsed, purpose: parsed.purpose.trim() }, prepared = await this.scope.places.request(input);
            const added = (record: EnvironmentRecord) => ({ id: record.id, name: record.name, note: "environments.switch with this id moves your tools there" });
            if ("granted" in prepared) return { status: "granted", ...added(prepared.granted), note: "You may already use it; environments.switch with this id moves your tools there" };
            const result = await this.ask(parsed.chatId, prepared.question, toolCallId, signal), found = this.scope.places.found(input);
            if (result.status !== "answered" || !found) return { messageId: result.messageId, status: "declined", note: "Your owner declined. Don't ask for its password in the chat; go on without it, or ask what they would like instead." };
            return { messageId: result.messageId, status: prepared.question.machine?.existing ? "granted" : "added", ...added(found) };
          }
          case "chats.create": return this.tools.create(args as Parameters<ChatTools["create"]>[0]);
          case "chats.update": return this.tools.update(args as Parameters<ChatTools["update"]>[0]);
          case "chats.addMembers": return this.tools.addMembers(args as Parameters<ChatTools["addMembers"]>[0]);
          case "chats.subscribe": return this.tools.subscribe(args as Parameters<ChatTools["subscribe"]>[0]);
          case "threads.list": return this.tools.threads(args as Parameters<ChatTools["threads"]>[0]);
          case "threads.follow": return this.tools.follow(args as Parameters<ChatTools["follow"]>[0]);
          case "sections.list": return this.tools.sections();
          case "sections.create": return this.tools.createSection(args as Parameters<ChatTools["createSection"]>[0]);
          case "sections.update": return this.tools.updateSection(args as Parameters<ChatTools["updateSection"]>[0]);
          case "messages.react": {
            const parsed = args as { messageId: string; emoji: string; on?: boolean };
            const wanted = parsed.on !== false, had = this.scope.chats.reactionOn(this.scope.botId, parsed.messageId, parsed.emoji);
            const message = this.scope.chats.react(this.scope.botId, parsed.messageId, parsed.emoji, wanted);
            const applied = wanted === had ? !wanted : wanted;
            return { messageId: message.id, emoji: parsed.emoji, [applied ? "marked" : "unmarked"]: true,
              note: applied ? "Reaction added" : "You already had this reaction, so this removed it",
              reactions: message.reactions.map(group => ({ emoji: group.emoji, count: group.memberIds.length })) };
          }
          case "messages.read": return this.tools.read(args as Parameters<ChatTools["read"]>[0], signal);
          case "files.get": {
            const { id, path } = args as { id: string; path?: string };
            const { file, data } = this.scope.files.open(this.scope.botId, id);
            signal?.throwIfAborted();
            return { path: await this.scope.workspace.put(file.name, id, data, path), name: file.name, type: file.mimeType, size: byteSize(file.size) };
          }
          case "files.view": {
            const { file, data } = this.scope.files.open(this.scope.botId, (args as { id: string }).id);
            return viewFile(file, data);
          }
          case "messages.search": return this.tools.search(args as Parameters<ChatTools["search"]>[0]);
          case "messages.send": {
            const parsed = args as { chatId?: string; to?: string; message: string; thread?: string; replyTo?: string; alsoToChannel?: boolean; attachments?: { path: string; name: string }[] };
            if ((parsed.chatId === undefined) === (parsed.to === undefined)) throw new ChatError(400, "Give either chatId or to");
            if (parsed.to !== undefined && (parsed.thread || parsed.alsoToChannel)) throw new ChatError(400, "thread and alsoToChannel need a channel chatId");
            if (parsed.replyTo !== undefined && !this.scope.chats.message(this.scope.botId, parsed.replyTo)) throw new ChatError(404, "Reply target not found");
            let chatId = parsed.to !== undefined ? this.scope.chats.openDirect(this.scope.botId, this.tools.members([parsed.to])[0]!.id).id : this.tools.chat(parsed.chatId!).id;
            if (parsed.thread) {
              const root = this.scope.chats.message(this.scope.botId, parsed.thread);
              if (!root || root.chatId !== chatId) throw new ChatError(404, "Message not found in this channel");
              chatId = this.scope.chats.threads.open(this.scope.botId, parsed.thread).id;
            }
            const before = this.readState(chatId);
            const sent = await this.send!(chatId, { content: parsed.message, attachments: parsed.attachments, ...(parsed.replyTo ? { replyTo: parsed.replyTo } : {}),
              ...(parsed.alsoToChannel ? { alsoToChannel: true } : {}), toolCallId, signal });
            const chat = this.scope.chats.get(this.scope.botId, chatId);
            if (!chat || chat.type === "dm") return { messageId: sent.id, chatId: sent.chatId, sequence: sent.sequence, ...this.unreadHint(before.unread, before.after) };
            const report = this.scope.chats.channels.mentionReport(this.scope.botId, chatId, parsed.message);
            // Saved mentions include the author of a replied-to message, not only the @ in the text.
            const notified = sent.mentions.map(id => this.scope.chats.member(id)?.name).filter((name): name is string => !!name);
            const subscribers = this.scope.chats.channels.subscribers(this.scope.botId, chatId).map(member => member.name)
              .filter(name => name !== this.scope.chats.member(this.scope.botId)?.name && !notified.includes(name));
            return { messageId: sent.id, chatId: sent.chatId, sequence: sent.sequence, notified,
              ...(subscribers.length ? { subscribers } : {}), ...(report.notInChannel.length ? { notInChannel: report.notInChannel } : {}), ...this.unreadHint(before.unread, before.after) };
          }
          case "messages.ask": {
            const parsed = args as { chatId: string; question: string; detail?: string; options: QuestionSpec["options"]; multiple?: boolean; allowCustom?: boolean };
            // Only people answer cards; in a chat of Bots alone the call would wait forever.
            if (!this.tools.chat(parsed.chatId).memberIds.some(id => this.scope.chats.member(id)?.kind === "user")) throw new ChatError(400, "No person in this chat to answer; use messages.send");
            const question: QuestionSpec = { question: parsed.question, ...(parsed.detail ? { detail: parsed.detail } : {}), options: parsed.options,
              multiple: parsed.multiple === true, allowCustom: parsed.allowCustom === true };
            // Unread before the card, plus what came in while it waited.
            const chatId = this.tools.chat(parsed.chatId).id, before = this.readState(chatId);
            const answer = await this.ask(chatId, question, toolCallId, signal);
            return { ...answer, ...this.unreadHint(before.unread + this.readState(chatId).unread, before.after) };
          }
        }
      },
    }];
  }
}
