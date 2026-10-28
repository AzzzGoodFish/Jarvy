import type { EnvironmentRecord } from "../../../shared/environment.js";
import { Type } from "typebox";
import { None, tool } from "./registry.js";

/** Where the Bot's file and command tools run (A50), and SSH machines it asks its owner for (A57). */
export const environmentTools = [
  tool("environments.list", "List the work environments you may use: your sandbox, your default and the ones your owner granted you. current is the id of the one you are in. Each has its id, name, the directory your file and command tools start in there, default=true for your default, and state for a sandbox (it starts when you switch to it).",
    None, (_args, context) => context.scope.places.list()),
  tool("environments.switch", "Move your file and command tools (bash, read, write, edit) to another work environment from environments.list, like cd one level up: you stay there, across turns, until you switch back. The result has your directory there and what you can do there. Commands already running finish where they started.",
    Type.Object({ id: Type.String({ minLength: 1, maxLength: 80, description: "The environment's id from environments.list" }) }, { additionalProperties: false }), ({ id }, context) => context.scope.places.switch(id)),
  tool("environments.request", "Ask your owner to add a machine you need to work on, reached over SSH, on a card in a chat with them, and wait for the answer, as messages.ask does. The card shows the machine's host key fingerprints for them to check; they let you in there, with its login password or by adding a key made for it to the machine. You never see the password or the key, so never ask for that password in the chat. It returns {status:\"added\", id, name} or {status:\"granted\", id, name} when you may already use it, then environments.switch with that id moves your tools there; or {status:\"declined\"}.",
    Type.Object({ chatId: Type.String(), host: Type.String({ minLength: 1, maxLength: 253, description: "Host name or IP address" }),
      user: Type.String({ minLength: 1, maxLength: 64, description: "The user to log in as" }), port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "Default 22" })),
      directory: Type.Optional(Type.String({ maxLength: 1000, description: "Where your tools start there: an absolute path or one under ~/; default the user's home" })),
      name: Type.Optional(Type.String({ maxLength: 40, description: "What to call the machine; default user@host" })),
      purpose: Type.String({ minLength: 1, maxLength: 300, description: "What you need it for, in your owner's language; shown on the card" }) }, { additionalProperties: false }), async (input, context, call) => {
    const { chatId, ...request } = input;
    context.withPerson(chatId, "ask in a chat with your owner");
    const places = context.scope.places, wanted = { ...request, purpose: request.purpose.trim() }, prepared = await places.request(wanted);
    const added = (record: EnvironmentRecord) => ({ id: record.id, name: record.name, note: "environments.switch with this id moves your tools there" });
    if ("granted" in prepared) return { status: "granted", ...added(prepared.granted), note: "You may already use it; environments.switch with this id moves your tools there" };
    const result = await context.ask(chatId, prepared.question, call), found = places.found(wanted);
    if (result.status !== "answered" || !found) return { messageId: result.messageId, status: "declined", note: "Your owner declined. Don't ask for its password in the chat; go on without it, or ask what they would like instead." };
    return { messageId: result.messageId, status: prepared.question.machine?.existing ? "granted" : "added", ...added(found) };
  }),
];
