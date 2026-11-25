import { Type } from "typebox";
import { ChatError } from "../../../shared/chat.js";
import { tool } from "./registry.js";

/** External service connectors (A102): discover, inspect, authorize and call tools without loading every schema up front. */
export const connectorTools = [
  tool(
    "connectors.list",
    {
      summary: "List external service connectors (GitHub, Gmail, Linear, remote MCPs), their status, tools, and grant state.",
      detail: "List external connectors (such as GitHub, Gmail, Linear or custom remote MCPs): slug, name, account (when connected), status, tools (write tools always ask the owner before running) and granted. Pass query to filter tools by keyword.",
    },
    Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Optional keyword to filter tools by name or description" })),
    }, { additionalProperties: false }),
    (args, context) => context.scope.connectors.list(args.query),
  ),
  tool(
    "connectors.describe",
    {
      summary: "Inspect a granted connector's tool schemas before calling connectors.call or connectors.batch.",
      detail: "Inspect one granted connector's tools and full JSON input schemas before calling connectors.call or connectors.batch. Pass tool for one tool, or query to search tools by keyword.",
    },
    Type.Object({
      connector: Type.String({ minLength: 1, maxLength: 64, description: "Connector slug from connectors.list" }),
      tool: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Optional exact tool name to inspect" })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Optional keyword to filter tools" })),
    }, { additionalProperties: false }),
    ({ connector, tool: toolName, query }, context) => context.scope.connectors.describe(connector, toolName, query),
  ),
  tool(
    "connectors.call",
    {
      summary: "Call one tool on a granted connector (write tools pause for owner confirmation on a card).",
      detail: "Call a tool on a granted connector. Inspect its schema with connectors.describe first. Every write tool pauses for the owner's confirmation on a card in the chat.",
    },
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
    "connectors.batch",
    {
      summary: "Call up to 50 tools on one granted connector (consolidates write confirmations onto a single card).",
      detail: "Call multiple tools on one granted connector (up to 50 items per batch). Prefer this over repeated connectors.call when making bulk changes (e.g. updating multiple Linear issues): all write items are shown together on a single confirmation card where your owner can review, optionally uncheck individual items, and confirm once. Split larger sets into batches of at most 50.",
    },
    Type.Object({
      chatId: Type.String({ description: "Current chat ID (used if write confirmation is required)" }),
      connector: Type.String({ minLength: 1, maxLength: 64, description: "Connector slug from connectors.list" }),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "Short summary of the batch in your owner's language, shown at the top of the card" })),
      items: Type.Array(Type.Object({
        tool: Type.String({ minLength: 1, maxLength: 120, description: "Tool name from connectors.describe" }),
        args: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: "object", description: "Tool arguments object" })),
        label: Type.Optional(Type.String({ minLength: 1, maxLength: 140, description: "Optional human-readable label for this item (e.g. 'ENG-101 Fix composer height')" })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 50, description: "Ordered list of tool calls to execute on this connector (1–50 items)" }),
    }, { additionalProperties: false }),
    (input, context, call) => context.scope.connectors.batch(
      input.chatId,
      input.connector,
      input.items.map(item => ({ tool: item.tool, args: item.args ?? {}, ...(item.label ? { label: item.label } : {}) })),
      input.summary,
      question => context.ask(input.chatId, question, call),
      () => context.hasPerson(input.chatId),
      call.signal,
    ),
  ),
  tool(
    "connectors.request",
    {
      summary: "Ask your owner on a card to grant access to one or multiple connected connectors.",
      detail: "Ask your owner on a card in a chat with them to grant access (for this run only or always) to one or more connected connectors you need. Pass connector for one, or connectors (up to 20 slugs) to ask for several on a single card. Returns immediately if all requested connectors are already granted; if any connector is not connected, ask your owner to connect it in Settings → Connectors.",
    },
    Type.Object({
      chatId: Type.String(),
      connector: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Single connector slug from connectors.list" })),
      connectors: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 20, description: "Multiple connector slugs from connectors.list to request together on one card" })),
      purpose: Type.String({ minLength: 1, maxLength: 300, description: "Why you need them, in your owner's language; shown on the card" }),
    }, { additionalProperties: false }),
    async (input, context, call) => {
      if (Boolean(input.connector) === Boolean(input.connectors?.length)) {
        throw new ChatError(400, "Pass either connector (single slug) or connectors (array of slugs), not both.");
      }
      const batchMode = Boolean(input.connectors?.length);
      const requested = batchMode ? input.connectors! : [input.connector!];
      context.withPerson(input.chatId, "ask in a chat with your owner");
      const prepared = await context.scope.connectors.prepare(requested, input.purpose.trim());
      if ("ready" in prepared) {
        return batchMode
          ? { status: "connected", granted: prepared.alreadyGranted, note: "All requested connectors are already granted and connected" }
          : { status: "connected", connector: input.connector!, note: "Granted and connected" };
      }
      const result = await context.ask(input.chatId, prepared.question, call);
      if (result.status !== "answered") {
        if (!batchMode) {
          return { messageId: result.messageId, status: "declined", note: "Your owner declined. Proceed without this connector, or ask what they prefer." };
        }
        return {
          messageId: result.messageId,
          status: prepared.alreadyGranted.length ? "partial" : "declined",
          granted: prepared.alreadyGranted,
          declined: prepared.pendingSlugs,
          note: "Your owner declined the requested connectors. Proceed without them, or ask what they prefer.",
        };
      }
      const picked = result.selected[0]?.value;
      if (!batchMode) {
        return {
          messageId: result.messageId, status: "connected", connector: input.connector!,
          ...(picked === "once" ? { until: "this run ends" } : {}),
        };
      }
      let newlyGranted = prepared.pendingSlugs;
      if (result.custom) {
        try {
          const parsed = JSON.parse(result.custom) as { granted?: unknown };
          if (Array.isArray(parsed?.granted)) {
            newlyGranted = parsed.granted.filter((slug): slug is string => typeof slug === "string");
          }
        } catch { /* fallback to pendingSlugs */ }
      }
      const newlySet = new Set(newlyGranted);
      const granted = [...prepared.alreadyGranted, ...newlyGranted];
      const declined = prepared.pendingSlugs.filter(slug => !newlySet.has(slug));
      return {
        messageId: result.messageId,
        status: declined.length === 0 ? "connected" : "partial",
        granted,
        ...(declined.length > 0 ? { declined } : {}),
        ...(picked === "once" ? { until: "this run ends" } : {}),
      };
    },
  ),
];
