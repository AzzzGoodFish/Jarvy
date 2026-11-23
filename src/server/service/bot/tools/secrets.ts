import { Type } from "typebox";
import { SECRET_CATEGORIES } from "../../../../contract/secrets.js";
import { placeholder } from "../../../shared/secret-mask.js";
import { tool } from "./registry.js";

const CategorySchema = Type.Union(
  SECRET_CATEGORIES.map(category => Type.Literal(category)),
  { description: "Category: login (website/account), api_key (API key/token), database (DB credentials), or other" },
);

/** The secrets a Bot may use (A52): their names, categories, non-secret associations (website/URL, username),
 * placeholders, and the card that asks the owner for one. */
export const secretTools = [
  tool(
    "secrets.list",
    "List your owner's secrets (tokens, logins, database passwords): each name, placeholder, category, optional associated url and username, description, and granted (whether you may use it); never the secret value. Pass optional query (matches name, description, url, username) or category to filter. To use one you may, write its placeholder, such as {{secret:GITHUB_TOKEN}}, in a bash command: it is filled in for that command only and shown masked in the output. For one with granted=false, ask with secrets.request.",
    Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Optional keyword to match name, description, url or username" })),
      category: Type.Optional(CategorySchema),
    }, { additionalProperties: false }),
    (args, context) => context.scope.secrets.list(args),
  ),
  tool(
    "secrets.request",
    "Ask your owner for a secret you need (a token, an API key, a website login password or a database password; to work on a machine over SSH, use environments.request) on a card in a chat with them, and wait for the answer, as messages.ask does. For one they keep already (in secrets.list) they only allow it; for a new one they enter the value on the card (optionally pre-filled with your category, url and username hints), which never shows the value in the chat. They let you use it until they revoke it or only until this run ends, or decline. It returns {status:\"granted\", placeholder, until} or {status:\"declined\"}; if you may already use it, it returns at once. Then write the placeholder in bash.",
    Type.Object({
      chatId: Type.String(),
      name: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$", description: "Capital letters, digits and underscores, such as GITHUB_TOKEN or STAGING_ADMIN_PASSWORD" }),
      purpose: Type.String({ minLength: 1, maxLength: 300, description: "What you need it for, in your owner's language; shown on the card" }),
      category: Type.Optional(CategorySchema),
      url: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "Optional associated website URL or service address (never include a password)" })),
      username: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Optional associated username, email or account identifier" })),
    }, { additionalProperties: false }),
    async (input, context, call) => {
      context.withPerson(input.chatId, "ask in a chat with your owner");
      const prepared = context.scope.secrets.prepare(input.name, input.purpose.trim(), {
        ...(input.category ? { category: input.category } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.username ? { username: input.username } : {}),
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
