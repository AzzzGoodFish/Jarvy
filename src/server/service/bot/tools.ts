import type { ToolDefinition } from "../../shared/tools.js";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ChatError } from "../../shared/chat.js";
import type { Tools as ToolsPort, OutgoingMessage, SentMessage } from "./contracts.js";
import { argumentProblems, invalidArguments, unknownTool } from "./tool-errors.js";
import { ToolContext, type ToolScope } from "./tools/context.js";
import type { BotTool } from "./tools/registry.js";
import { historyTools } from "./tools/history.js";
import { chatTools } from "./tools/chats.js";
import { messageTools } from "./tools/messages.js";
import { fileTools } from "./tools/files.js";
import { environmentTools } from "./tools/environments.js";
import { secretTools } from "./tools/secrets.js";
import { taskTools } from "./tools/tasks.js";
import { agentTools } from "./tools/agent.js";

/** Every Bot's tools, by area, in the order list gives them; the agent Bot also has its own (A48), after them. */
const EVERY_BOT: readonly BotTool[] = [...historyTools, ...chatTools, ...messageTools, ...fileTools, ...environmentTools, ...secretTools, ...taskTools];

// The one schema a model gets as a function definition, so it keeps to what every provider takes: Gemini refuses
// anyOf/const and patternProperties, so action is a plain string enum and args a plain object. The tools behind the
// gateway keep their own schemas, since describe hands those over as a result.
const Gateway = Type.Object({ action: Type.Unsafe<"list" | "describe" | "call">({ type: "string", enum: ["list", "describe", "call"] }),
  tool: Type.Optional(Type.String()), args: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: "object" })) }, { additionalProperties: false });
/** The `chat` gateway (A37): one tool in front of the Bot's chat tools. It lists them, describes one, checks the
 * arguments against its parameters and runs it; each tool is registered once (tools/), with what it does. */
export class Tools implements ToolsPort {
  private send?: (chatId: string, message: OutgoingMessage) => Promise<SentMessage>;
  private readonly context: ToolContext;
  private readonly tools: ReadonlyMap<string, BotTool>;
  constructor(scope: ToolScope) {
    this.context = new ToolContext(scope, () => this.send);
    this.tools = new Map([...EVERY_BOT, ...(scope.agent ? agentTools : [])].map(entry => [entry.name, entry]));
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
          return [...this.tools.values()].map(entry => ({ name: entry.name, description: entry.description }));
        }
        const found = raw.tool ? this.tools.get(raw.tool) : undefined;
        if (!found) throw new ChatError(400, unknownTool(raw.tool, [...this.tools.keys()]));
        if (raw.action === "describe") {
          if (raw.args !== undefined) throw new ChatError(400, "describe does not accept args");
          return { name: found.name, description: found.description, parameters: found.schema };
        }
        if (!raw.args || !Value.Check(found.schema, raw.args)) throw new ChatError(400, invalidArguments(found.name, found.schema, raw.args));
        return found.run(raw.args, this.context, { toolCallId, signal });
      },
    }];
  }
}
