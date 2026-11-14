import { Type } from "typebox";
import { None, tool } from "./registry.js";

/** External service connectors (A95): discover, inspect, authorize and call tools without loading every schema up front. */
export const connectorTools = [
  tool(
    "connectors.list",
    "List external connectors (such as Linear, Notion, Figma or custom remote MCPs): slug, name, status, safety mode, tool names and granted (whether you may use it). Use connectors.request for one with granted=false or status!=connected.",
    None,
    (_args, context) => context.scope.connectors.list(),
  ),
  tool(
    "connectors.describe",
    "Inspect one granted connector's tools and full JSON input schemas before calling connectors.call. Pass tool to inspect a single tool.",
    Type.Object({
      connector: Type.String({ minLength: 1, maxLength: 64, description: "Connector slug from connectors.list" }),
      tool: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Optional tool name to inspect" })),
    }, { additionalProperties: false }),
    ({ connector, tool: toolName }, context) => context.scope.connectors.describe(connector, toolName),
  ),
  tool(
    "connectors.call",
    "Call a tool on a granted connector. Inspect its schema with connectors.describe first. Write actions on confirm_writes connectors pause for owner confirmation on a card in the chat.",
    Type.Object({
      chatId: Type.String({ description: "Current chat ID (used if write confirmation is required)" }),
      connector: Type.String({ minLength: 1, maxLength: 64, description: "Connector slug from connectors.list" }),
      tool: Type.String({ minLength: 1, maxLength: 120, description: "Tool name from connectors.describe" }),
      args: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: "object", description: "Tool arguments object" })),
    }, { additionalProperties: false }),
    (input, context, call) => context.scope.connectors.call(
      input.chatId,
      input.connector,
      input.tool,
      input.args ?? {},
      question => context.ask(input.chatId, question, call),
      () => context.hasPerson(input.chatId),
      call.signal,
    ),
  ),
  tool(
    "connectors.request",
    "Ask your owner on a card in a chat with them to grant or authorize a connector you need. Returns immediately if already granted and connected; otherwise waits until authorized and allowed, or declined.",
    Type.Object({
      chatId: Type.String(),
      connector: Type.String({ minLength: 1, maxLength: 64, description: "Connector slug from connectors.list" }),
      purpose: Type.String({ minLength: 1, maxLength: 300, description: "Why you need it, in your owner's language; shown on the card" }),
    }, { additionalProperties: false }),
    async (input, context, call) => {
      context.withPerson(input.chatId, "ask in a chat with your owner");
      const prepared = await context.scope.connectors.prepare(input.connector, input.purpose.trim());
      if ("ready" in prepared) return { status: "connected", connector: input.connector, note: "Granted and connected" };
      const result = await context.ask(input.chatId, prepared.question, call);
      if (result.status !== "answered") {
        return { messageId: result.messageId, status: "declined", note: "Your owner declined. Proceed without this connector, or ask what they prefer." };
      }
      return { messageId: result.messageId, status: "connected", connector: input.connector };
    },
  ),
];
