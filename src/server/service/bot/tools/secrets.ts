import { Type } from "typebox";
import { placeholder } from "../../../shared/secret-mask.js";
import { None, tool } from "./registry.js";

/** The secrets a Bot may use (A52): their names and placeholders, and the card that asks the owner for one. */
export const secretTools = [
  tool("secrets.list", "List the secrets (tokens, passwords) your owner lets you use: each name, its placeholder and what it is for, never the value. To use one, write its placeholder, such as {{secret:GITHUB_TOKEN}}, in a bash command: it is filled in for that command only and shown masked in the output.",
    None, (_args, context) => context.scope.secrets.list()),
  tool("secrets.request", "Ask your owner for a secret you need (a token, an API key or a password; to work on a machine over SSH, use environments.request) on a card in a chat with them, and wait for the answer, as messages.ask does. They enter the value on the card, which never shows it in the chat, and let you use it until they revoke it or only until this run ends, or decline. It returns {status:\"granted\", placeholder, until} or {status:\"declined\"}; if you may already use it, it returns at once. Then write the placeholder in bash.",
    Type.Object({ chatId: Type.String(), name: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$", description: "Capital letters, digits and underscores, such as GITHUB_TOKEN" }),
      purpose: Type.String({ minLength: 1, maxLength: 300, description: "What you need it for, in your owner's language; shown on the card" }) }, { additionalProperties: false }), async (input, context, call) => {
    context.withPerson(input.chatId, "ask in a chat with your owner");
    const prepared = context.scope.secrets.prepare(input.name, input.purpose.trim());
    if ("granted" in prepared) return { status: "granted", name: input.name, placeholder: placeholder(input.name), note: "You may already use it" };
    const result = await context.ask(input.chatId, prepared.question, call);
    if (result.status !== "answered") return { messageId: result.messageId, status: "declined", note: "Your owner declined. Don't ask for the value in the chat; go on without it, or ask what they would like instead." };
    return { messageId: result.messageId, status: "granted", name: input.name, placeholder: placeholder(input.name),
      until: result.selected[0]?.value === "once" ? "this run ends" : "your owner revokes it" };
  }),
];
