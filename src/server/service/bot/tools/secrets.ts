import { Type } from "typebox";
import { SECRET_CATEGORIES } from "../../../../contract/secrets.js";
import { placeholder } from "../../../shared/secret-mask.js";
import { tool } from "./registry.js";

const CategorySchema = Type.Union(
  SECRET_CATEGORIES.map(category => Type.Literal(category)),
  { description: "Secret template type: login (url, username + password), api_key (url + API key/token), database (host, port, database, username + password), or other" },
);

const FieldHintSchema = Type.Object({
  key: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$", description: "Field key, e.g. url, username, host, port, database, api_secret, tenant_id" }),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: "Optional human-readable label for a custom field" })),
  secret: Type.Boolean({ description: "true if this field's value is secret (entered masked on card and used via {{secret:NAME.FIELD}}); false for public metadata" }),
  value: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Optional pre-filled value for a non-secret field (ignored when secret=true)" })),
}, { additionalProperties: false });

/** The secrets a Bot may use (A52): their names, categories, structured public fields, placeholders for primary and
 * custom secret fields, and the card that asks the owner for one. */
export const secretTools = [
  tool(
    "secrets.list",
    {
      summary: "List stored secrets (category, public fields, {{secret:...}} placeholders, granted); optional query/category filter.",
      detail: "List your owner's secrets: each name, primary placeholder ({{secret:NAME}}), category (login/api_key/database/other), description, structured fields (public fields include value; secret fields include placeholder {{secret:NAME.FIELD}}), and granted. Pass optional query or category to filter. Write placeholders in bash commands; secret values are filled in for that command only and masked in output. For granted=false, ask with secrets.request.",
    },
    Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Optional keyword to match name, description or any non-secret field" })),
      category: Type.Optional(CategorySchema),
    }, { additionalProperties: false }),
    (args, context) => context.scope.secrets.list(args),
  ),
  tool(
    "secrets.request",
    {
      summary: "Ask your owner on a card to grant or enter a stored secret (supports category and structured/custom fields).",
      detail: "Ask your owner for a stored credential on a card in a chat with them, and wait for the answer, as messages.ask does (for SSH machines, use environments.request). Choose a category (login, api_key, database, other) and optionally pass fields (both built-in public fields like url/username/host/port/database and custom extensible fields with secret=true or secret=false). For an existing secret (in secrets.list) they only allow it; for a new one they fill in the primary value and any fields on the card without exposing secrets in chat. Returns {status:\"granted\", placeholder, until} or {status:\"declined\"}; if already granted, returns at once.",
    },
    Type.Object({
      chatId: Type.String(),
      name: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$", description: "Capital letters, digits and underscores, such as GITHUB_TOKEN or STAGING_ADMIN" }),
      purpose: Type.String({ minLength: 1, maxLength: 300, description: "What you need it for, in your owner's language; shown on the card" }),
      category: Type.Optional(CategorySchema),
      fields: Type.Optional(Type.Array(FieldHintSchema, { maxItems: 16, description: "Optional built-in or custom fields (set secret=true for extra secret values like api_secret)" })),
    }, { additionalProperties: false }),
    async (input, context, call) => {
      context.withPerson(input.chatId, "ask in a chat with your owner");
      const prepared = context.scope.secrets.prepare(input.name, input.purpose.trim(), {
        ...(input.category ? { category: input.category } : {}),
        ...(input.fields?.length ? { fields: input.fields } : {}),
      });
      if ("granted" in prepared) return { status: "granted", name: input.name, placeholder: placeholder(input.name), note: "You may already use it" };
      const result = await context.ask(input.chatId, prepared.question, call);
      if (result.status !== "answered") return { messageId: result.messageId, status: "declined", note: "Your owner declined. Don't ask for the value in the chat; go on without it, or ask what they would like instead." };
      return {
        messageId: result.messageId, status: "granted", name: input.name, placeholder: placeholder(input.name),
        until: result.selected[0]?.value === "once" ? "this run ends" : "your owner revokes it",
      };
    },
  ),
];
