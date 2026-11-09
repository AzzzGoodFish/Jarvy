import type { EnvironmentRecord } from "../../../shared/environment.js";
import { Type } from "typebox";
import { ChatError } from "../../../shared/chat.js";
import { None, tool } from "./registry.js";

/** Where the Bot's file and command tools run (A50), and SSH machines it asks its owner for (A57). */
export const environmentTools = [
  tool("environments.list", "List the work environments: your own sandbox, which is your default, and your owner's machines reached over SSH, with granted, whether you may use one. current is the id of the one you are in. Each has its id, name, the directory your file and command tools start in there, default=true for your default, state for a sandbox (it starts when you switch to it), and for an SSH machine its address and, when your owner wrote one, their description of it: what it is for and what to watch out for. For one with granted=false, ask with environments.request and its id.",
    None, (_args, context) => context.scope.places.list()),
  tool("environments.switch", "Move your file and command tools (bash, read, write, edit) to another work environment you may use from environments.list, like cd one level up: you stay there, across turns, until you switch back. The result has your directory there and what you can do there. Commands already running finish where they started.",
    Type.Object({ id: Type.String({ minLength: 1, maxLength: 80, description: "The environment's id from environments.list" }) }, { additionalProperties: false }), ({ id }, context) => context.scope.places.switch(id)),
  tool("environments.request", "Ask your owner for a machine you need to work on, reached over SSH, on a card in a chat with them, and wait for the answer, as messages.ask does: one of theirs from environments.list that you may not use yet, by its id, which they only have to allow, or a new one, by its host and user. For a new one the card shows the machine's host key fingerprints for them to check; they let you in there, with its login password or by adding a key made for it to the machine. You never see the password or the key, so never ask for that password in the chat. It returns {status:\"added\", id, name} or {status:\"granted\", id, name} when you may already use it, then environments.switch with that id moves your tools there; or {status:\"declined\"}.",
    Type.Object({ chatId: Type.String(), id: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "One of your owner's machines from environments.list; then leave out host, user, port, directory and name" })),
      host: Type.Optional(Type.String({ minLength: 1, maxLength: 253, description: "A new machine: its host name or IP address" })),
      user: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "A new machine: the user to log in as" })), port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "Default 22" })),
      directory: Type.Optional(Type.String({ maxLength: 1000, description: "Where your tools start there: an absolute path or one under ~/; default the user's home" })),
      name: Type.Optional(Type.String({ maxLength: 40, description: "What to call the machine; default user@host" })),
      purpose: Type.String({ minLength: 1, maxLength: 300, description: "What you need it for, in your owner's language; shown on the card" }) }, { additionalProperties: false }), async (input, context, call) => {
    const { chatId, id, host, user, ...rest } = input;
    context.withPerson(chatId, "ask in a chat with your owner");
    const places = context.scope.places, known = id === undefined ? null : places.address(id);
    if (id !== undefined && !known) throw new ChatError(404, "No machine of your owner's with this id; see environments.list");
    const where = known ?? (host && user ? { host, user, ...(rest.port !== undefined ? { port: rest.port } : {}) } : null);
    if (!where) throw new ChatError(400, "Give the id of one of your owner's machines from environments.list, or the host and user of a new one");
    const wanted = { ...(known ? {} : rest), ...where, purpose: rest.purpose.trim() }, prepared = await places.request(wanted);
    const added = (record: EnvironmentRecord) => ({ id: record.id, name: record.name, note: "environments.switch with this id moves your tools there" });
    if ("granted" in prepared) return { status: "granted", ...added(prepared.granted), note: "You may already use it; environments.switch with this id moves your tools there" };
    const result = await context.ask(chatId, prepared.question, call), found = places.found(wanted);
    if (result.status !== "answered" || !found) return { messageId: result.messageId, status: "declined", note: "Your owner declined. Don't ask for its password in the chat; go on without it, or ask what they would like instead." };
    return { messageId: result.messageId, status: prepared.question.machine?.existing ? "granted" : "added", ...added(found) };
  }),
];
