import type { EnvironmentRecord } from "../../../shared/environment.js";
import { Type } from "typebox";
import { ChatError } from "../../../shared/chat.js";
import { None, tool } from "./registry.js";

/** Where the Bot's file and command tools run (A50), and SSH machines it asks its owner for (A57). */
export const environmentTools = [
  tool("environments.list", {
    summary: "List your sandbox, granted/ungranted SSH machines, and connected desktop devices, plus which one is active.",
    detail: "List work environments: your own sandbox (container or VM, your default), your owner's SSH machines, and connected desktop devices (Windows/macOS/Linux), with granted (whether you may use each) and current (the id you are in now). Entries include id, name, starting directory, platform/shell/state, limits or problems, address, and any owner description. For an ungranted external environment, ask with environments.request and its id.",
  },
    None, (_args, context) => context.scope.places.list()),
  tool("environments.switch", {
    summary: "Move file and command tools (bash, read, write, edit) to another granted environment by id.",
    detail: "Move your file and command tools (bash, read, write, edit) to another granted work environment from environments.list, like cd one level up: you stay there across turns until you switch back. The result includes your starting directory, OS/shell notes, and capabilities there. Commands already running finish where they started.",
  },
    Type.Object({ id: Type.String({ minLength: 1, maxLength: 80, description: "The environment's id from environments.list" }) }, { additionalProperties: false }), ({ id }, context) => context.scope.places.switch(id)),
  tool("environments.request", {
    summary: "Ask your owner on a card for access to an ungranted machine/device (by id) or to add a new SSH machine.",
    detail: "Ask your owner on a card in a chat with them for access to a work environment, and wait for the answer (as messages.ask does): pass id for an existing ungranted SSH machine or connected device from environments.list, or host and user to add a new SSH machine. For a new SSH machine the card shows host key fingerprints and takes its login password or key without exposing it in chat. Returns {status:\"added\"|\"granted\", id, name} (then call environments.switch) or {status:\"declined\"}.",
  },
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
